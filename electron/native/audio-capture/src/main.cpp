// audio-capture.exe: Livepad's native capture helper (1.5.0, Windows only).
//
// Lists the apps with Windows audio sessions and the playback endpoints, and records
// one of them at a time as 48 kHz mono 16-bit PCM. Electron spawns it only while
// Livepad needs it, and it exits when its stdin closes, so it can't outlive the app.
//
// stdin, one command per line (UTF-8):
//   start <key>     capture a source from the latest list (replaces any current one)
//   stop            stop capturing
//   list            re-send the source list
//
// stdout, framed binary: 1 byte type, 3 reserved, u32 LE payload length, payload.
//   type 1  UTF-8 JSON event:
//     {"t":"hello","build":19045,"perApp":true}
//     {"t":"sources","apps":[{"key":"app:<lowercased exe path>","name":"..."}],
//                    "devices":[{"key":"device:<endpoint id>","name":"...","default":false}]}
//     {"t":"state","state":"capturing|waiting|idle","key":"...","hr":"0x..."}   (hr only on failures)
//   type 2  PCM: little-endian Int16 mono at 48 kHz
//
// What the spike measured on build 19045, which this design relies on:
//   - Initialize accepts 48 kHz mono 16-bit on both paths with AUTOCONVERTPCM.
//   - A process-loopback stream gives no signal when its target exits, and activating a
//     dead PID succeeds, so loss is detected from a process handle.
//   - An idle app keeps delivering packets, but an idle playback endpoint delivers none,
//     so the device path fills those stretches with silence. Otherwise "the last 30
//     seconds" would quietly reach back further than 30 seconds.

#include <windows.h>
#include <initguid.h>
#include <mmdeviceapi.h>
#include <audioclient.h>
#include <audioclientactivationparams.h>
#include <audiopolicy.h>
#include <functiondiscoverykeys_devpkey.h>
#include <avrt.h>
#include <tlhelp32.h>
#include <wrl/client.h>
#include <wrl/implements.h>

#include <cstdint>
#include <cstdio>
#include <map>
#include <set>
#include <string>
#include <vector>

using Microsoft::WRL::ClassicCom;
using Microsoft::WRL::ComPtr;
using Microsoft::WRL::FtmBase;
using Microsoft::WRL::Make;
using Microsoft::WRL::RuntimeClass;
using Microsoft::WRL::RuntimeClassFlags;

namespace {

const uint32_t kRate = 48000;
const uint32_t kChunkFrames = 2048;     // about 43 ms per message
const DWORD kRelistDebounceMs = 150;
const DWORD kWaitingRetryMs = 2000;
const DWORD kSilenceFillAfterMs = 100;  // shortest no-packet stretch treated as an idle device
const DWORD kMinProcessLoopbackBuild = 19041;

std::string utf8(const std::wstring& w) {
  if (w.empty()) return {};
  int n = WideCharToMultiByte(CP_UTF8, 0, w.c_str(), (int)w.size(), nullptr, 0, nullptr, nullptr);
  std::string s(n, 0);
  WideCharToMultiByte(CP_UTF8, 0, w.c_str(), (int)w.size(), s.data(), n, nullptr, nullptr);
  return s;
}

std::wstring wide(const std::string& s) {
  if (s.empty()) return {};
  int n = MultiByteToWideChar(CP_UTF8, 0, s.c_str(), (int)s.size(), nullptr, 0);
  std::wstring w(n, 0);
  MultiByteToWideChar(CP_UTF8, 0, s.c_str(), (int)s.size(), w.data(), n);
  return w;
}

std::wstring lower(std::wstring s) {
  if (!s.empty()) CharLowerBuffW(s.data(), (DWORD)s.size());
  return s;
}

std::string json(const std::string& s) {
  std::string o = "\"";
  for (unsigned char c : s) {
    if (c == '"' || c == '\\') { o += '\\'; o += (char)c; }
    else if (c < 0x20) { char b[8]; snprintf(b, sizeof b, "\\u%04x", c); o += b; }
    else o += (char)c;
  }
  return o + "\"";
}

std::string hex(HRESULT hr) {
  char b[16];
  snprintf(b, sizeof b, "0x%08lX", (unsigned long)hr);
  return b;
}

// --- Output -------------------------------------------------------------------

HANDLE g_stdout;
CRITICAL_SECTION g_outLock;

void writeAll(const void* data, DWORD len) {
  auto* p = static_cast<const BYTE*>(data);
  while (len > 0) {
    DWORD wrote = 0;
    // A broken pipe means Electron is gone, and nothing may keep recording after that.
    if (!WriteFile(g_stdout, p, len, &wrote, nullptr)) ExitProcess(0);
    p += wrote;
    len -= wrote;
  }
}

void writeFrame(uint8_t type, const void* data, uint32_t len) {
  BYTE header[8] = {type, 0, 0, 0, BYTE(len), BYTE(len >> 8), BYTE(len >> 16), BYTE(len >> 24)};
  EnterCriticalSection(&g_outLock);
  writeAll(header, sizeof header);
  writeAll(data, len);
  LeaveCriticalSection(&g_outLock);
}

void emit(const std::string& s) { writeFrame(1, s.data(), (uint32_t)s.size()); }

// --- Source snapshot ------------------------------------------------------------

struct AppEntry {
  std::string key, name;
  DWORD rootPid = 0;
};

struct DeviceEntry {
  std::string key, name;
  std::wstring id;
  bool isDefault = false;
};

CRITICAL_SECTION g_sourcesLock;
std::map<std::string, AppEntry> g_apps;
std::map<std::string, DeviceEntry> g_devices;

HANDLE g_relist;         // a source may have changed
HANDLE g_captureChanged; // new command or new list for the capture thread

std::wstring g_excludeExe;

// --- Change notifications -------------------------------------------------------
// These callbacks may not block or call back into the session manager, so each only
// raises an event and the watch thread does the work.

class SessionNotifier : public RuntimeClass<RuntimeClassFlags<ClassicCom>, FtmBase, IAudioSessionNotification> {
 public:
  STDMETHOD(OnSessionCreated)(IAudioSessionControl*) override { SetEvent(g_relist); return S_OK; }
};

class EndpointNotifier : public RuntimeClass<RuntimeClassFlags<ClassicCom>, FtmBase, IMMNotificationClient> {
 public:
  STDMETHOD(OnDeviceStateChanged)(LPCWSTR, DWORD) override { SetEvent(g_relist); return S_OK; }
  STDMETHOD(OnDeviceAdded)(LPCWSTR) override { SetEvent(g_relist); return S_OK; }
  STDMETHOD(OnDeviceRemoved)(LPCWSTR) override { SetEvent(g_relist); return S_OK; }
  STDMETHOD(OnDefaultDeviceChanged)(EDataFlow, ERole, LPCWSTR) override { SetEvent(g_relist); return S_OK; }
  STDMETHOD(OnPropertyValueChanged)(LPCWSTR, const PROPERTYKEY) override { return S_OK; }
};

VOID CALLBACK onProcessExit(PVOID, BOOLEAN) { SetEvent(g_relist); }

// --- Listing ----------------------------------------------------------------------

struct WatchedProcess {
  HANDLE process = nullptr;
  HANDLE wait = nullptr;
};

struct WatchedEndpoint {
  ComPtr<IAudioSessionManager2> manager;
  ComPtr<IAudioSessionEnumerator> sessions;  // notifications need an enumerator to exist
  ComPtr<SessionNotifier> notifier;
};

std::wstring exePathOf(HANDLE process) {
  wchar_t buf[MAX_PATH * 2];
  DWORD n = ARRAYSIZE(buf);
  return QueryFullProcessImageNameW(process, 0, buf, &n) ? std::wstring(buf, n) : std::wstring();
}

std::wstring exePathOfPid(DWORD pid) {
  HANDLE p = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
  if (!p) return {};
  std::wstring out = exePathOf(p);
  CloseHandle(p);
  return out;
}

std::wstring fileStem(const std::wstring& path) {
  size_t slash = path.find_last_of(L"\\/");
  std::wstring name = slash == std::wstring::npos ? path : path.substr(slash + 1);
  size_t dot = name.find_last_of(L'.');
  return dot == std::wstring::npos ? name : name.substr(0, dot);
}

std::wstring displayName(const std::wstring& exe) {
  DWORD ignored = 0, size = GetFileVersionInfoSizeW(exe.c_str(), &ignored);
  if (size) {
    std::vector<BYTE> info(size);
    struct Translation { WORD lang, code; }* tr = nullptr;
    UINT trLen = 0;
    if (GetFileVersionInfoW(exe.c_str(), 0, size, info.data()) &&
        VerQueryValueW(info.data(), L"\\VarFileInfo\\Translation", (LPVOID*)&tr, &trLen) && trLen >= sizeof(Translation)) {
      wchar_t query[64];
      swprintf(query, 64, L"\\StringFileInfo\\%04x%04x\\FileDescription", tr->lang, tr->code);
      wchar_t* text = nullptr;
      UINT textLen = 0;
      if (VerQueryValueW(info.data(), query, (LPVOID*)&text, &textLen) && textLen > 1) {
        // The exe's own resource supplies both the text and its length, so stay inside
        // the buffer we allocated and stop at a missing or early terminator.
        const BYTE* start = reinterpret_cast<const BYTE*>(text);
        const BYTE* begin = info.data();
        const BYTE* end = begin + size;
        if (start >= begin && start < end) {
          size_t room = static_cast<size_t>(end - start) / sizeof(wchar_t);
          std::wstring s(text, wcsnlen(text, textLen < room ? textLen : room));
          if (!s.empty()) return s;
        }
      }
    }
  }
  return fileStem(exe);
}

std::string endpointName(IMMDevice* dev) {
  ComPtr<IPropertyStore> props;
  if (FAILED(dev->OpenPropertyStore(STGM_READ, &props))) return {};
  PROPVARIANT v;
  PropVariantInit(&v);
  std::string name;
  if (SUCCEEDED(props->GetValue(PKEY_Device_FriendlyName, &v)) && v.vt == VT_LPWSTR) name = utf8(v.pwszVal);
  PropVariantClear(&v);
  return name;
}

// A multi-process app usually plays from a child (Chromium's audio utility process).
// Capturing the topmost ancestor with the same exe covers every process of the app.
DWORD rootOf(DWORD pid, const std::wstring& exeLower, const std::map<DWORD, DWORD>& parents) {
  for (int depth = 0; depth < 16; depth++) {
    auto it = parents.find(pid);
    if (it == parents.end() || it->second == 0 || it->second == pid) break;
    if (lower(exePathOfPid(it->second)) != exeLower) break;
    pid = it->second;
  }
  return pid;
}

class Watcher {
 public:
  void run() {
    if (FAILED(CoCreateInstance(__uuidof(MMDeviceEnumerator), nullptr, CLSCTX_ALL, IID_PPV_ARGS(&enumerator_)))) return;
    endpointNotifier_ = Make<EndpointNotifier>();
    enumerator_->RegisterEndpointNotificationCallback(endpointNotifier_.Get());
    for (;;) {
      relist();
      WaitForSingleObject(g_relist, INFINITE);
      Sleep(kRelistDebounceMs);
      ResetEvent(g_relist);
    }
  }

 private:
  void watchEndpoint(const std::wstring& id, IMMDevice* dev, WatchedEndpoint& entry) {
    if (entry.manager) return;
    if (FAILED(dev->Activate(__uuidof(IAudioSessionManager2), CLSCTX_ALL, nullptr, (void**)entry.manager.GetAddressOf()))) return;
    entry.notifier = Make<SessionNotifier>();
    entry.manager->GetSessionEnumerator(&entry.sessions);
    entry.manager->RegisterSessionNotification(entry.notifier.Get());
    (void)id;
  }

  // True if the process is alive; keeps a handle so its exit triggers a re-list.
  bool watchProcess(DWORD pid) {
    auto it = processes_.find(pid);
    if (it == processes_.end()) {
      WatchedProcess w;
      w.process = OpenProcess(SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
      if (!w.process) return false;
      RegisterWaitForSingleObject(&w.wait, w.process, onProcessExit, nullptr, INFINITE, WT_EXECUTEONLYONCE);
      it = processes_.emplace(pid, w).first;
    }
    return WaitForSingleObject(it->second.process, 0) != WAIT_OBJECT_0;
  }

  void relist() {
    std::map<std::string, DeviceEntry> devices;
    std::map<std::string, AppEntry> apps;
    std::map<DWORD, std::wstring> sessionPids;
    std::set<DWORD> seen;

    std::wstring defaultId;
    ComPtr<IMMDevice> def;
    if (SUCCEEDED(enumerator_->GetDefaultAudioEndpoint(eRender, eConsole, &def))) {
      LPWSTR id = nullptr;
      if (SUCCEEDED(def->GetId(&id))) { defaultId = id; CoTaskMemFree(id); }
    }

    ComPtr<IMMDeviceCollection> col;
    UINT count = 0;
    if (SUCCEEDED(enumerator_->EnumAudioEndpoints(eRender, DEVICE_STATE_ACTIVE, &col))) col->GetCount(&count);
    std::set<std::wstring> liveEndpoints;
    for (UINT i = 0; i < count; i++) {
      ComPtr<IMMDevice> dev;
      LPWSTR rawId = nullptr;
      if (FAILED(col->Item(i, &dev)) || FAILED(dev->GetId(&rawId))) continue;
      std::wstring id = rawId;
      CoTaskMemFree(rawId);
      liveEndpoints.insert(id);

      DeviceEntry d;
      d.id = id;
      d.key = "device:" + utf8(id);
      d.name = endpointName(dev.Get());
      d.isDefault = id == defaultId;
      devices[d.key] = d;

      WatchedEndpoint& ep = endpoints_[id];
      watchEndpoint(id, dev.Get(), ep);
      ComPtr<IAudioSessionEnumerator> sessions;
      int n = 0;
      if (ep.manager && SUCCEEDED(ep.manager->GetSessionEnumerator(&sessions))) { ep.sessions = sessions; sessions->GetCount(&n); }
      for (int s = 0; s < n; s++) {
        ComPtr<IAudioSessionControl> ctl;
        ComPtr<IAudioSessionControl2> ctl2;
        if (FAILED(sessions->GetSession(s, &ctl)) || FAILED(ctl.As(&ctl2))) continue;
        if (ctl2->IsSystemSoundsSession() == S_OK) continue;
        AudioSessionState state = AudioSessionStateInactive;
        if (FAILED(ctl->GetState(&state)) || state == AudioSessionStateExpired) continue;
        DWORD pid = 0;
        if (FAILED(ctl2->GetProcessId(&pid)) || pid == 0 || pid == GetCurrentProcessId()) continue;
        seen.insert(pid);
        if (sessionPids.count(pid)) continue;
        if (!watchProcess(pid)) continue;
        // Empty for processes we may not query (services, protected games).
        std::wstring exe = exePathOfPid(pid);
        if (!exe.empty() && lower(exe) != g_excludeExe) sessionPids[pid] = exe;
      }
    }

    for (auto it = endpoints_.begin(); it != endpoints_.end();) {
      if (liveEndpoints.count(it->first)) { ++it; continue; }
      if (it->second.manager) it->second.manager->UnregisterSessionNotification(it->second.notifier.Get());
      it = endpoints_.erase(it);
    }
    for (auto it = processes_.begin(); it != processes_.end();) {
      if (seen.count(it->first)) { ++it; continue; }
      if (it->second.wait) UnregisterWaitEx(it->second.wait, INVALID_HANDLE_VALUE);
      CloseHandle(it->second.process);
      it = processes_.erase(it);
    }

    std::map<DWORD, DWORD> parents;
    HANDLE snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
    if (snap != INVALID_HANDLE_VALUE) {
      PROCESSENTRY32W pe{sizeof pe};
      for (BOOL ok = Process32FirstW(snap, &pe); ok; ok = Process32NextW(snap, &pe)) parents[pe.th32ProcessID] = pe.th32ParentProcessID;
      CloseHandle(snap);
    }
    for (auto& [pid, exe] : sessionPids) {
      std::wstring exeLower = lower(exe);
      std::string key = "app:" + utf8(exeLower);
      if (apps.count(key)) continue;  // two instances of one exe: the first found is captured
      AppEntry a;
      a.key = key;
      a.rootPid = rootOf(pid, exeLower, parents);
      auto nameIt = names_.find(exeLower);
      if (nameIt == names_.end()) nameIt = names_.emplace(exeLower, utf8(displayName(exe))).first;
      a.name = nameIt->second;
      apps[key] = a;
    }

    std::string out = "{\"t\":\"sources\",\"apps\":[";
    bool first = true;
    for (auto& [key, a] : apps) {
      out += std::string(first ? "" : ",") + "{\"key\":" + json(key) + ",\"name\":" + json(a.name) + "}";
      first = false;
    }
    out += "],\"devices\":[";
    first = true;
    for (auto& [key, d] : devices) {
      out += std::string(first ? "" : ",") + "{\"key\":" + json(key) + ",\"name\":" + json(d.name) + ",\"default\":" + (d.isDefault ? "true" : "false") + "}";
      first = false;
    }
    out += "]}";

    EnterCriticalSection(&g_sourcesLock);
    g_apps = std::move(apps);
    g_devices = std::move(devices);
    LeaveCriticalSection(&g_sourcesLock);
    SetEvent(g_captureChanged);
    if (out != last_ || force_) emit(out);
    last_ = out;
    force_ = false;
  }

 public:
  bool force_ = false;

 private:
  ComPtr<IMMDeviceEnumerator> enumerator_;
  ComPtr<EndpointNotifier> endpointNotifier_;
  std::map<std::wstring, WatchedEndpoint> endpoints_;
  std::map<DWORD, WatchedProcess> processes_;
  std::map<std::wstring, std::string> names_;
  std::string last_;
};

Watcher* g_watcher = nullptr;

// --- Activation ----------------------------------------------------------------

class ActivateHandler : public RuntimeClass<RuntimeClassFlags<ClassicCom>, FtmBase, IActivateAudioInterfaceCompletionHandler> {
 public:
  HANDLE done = CreateEventW(nullptr, TRUE, FALSE, nullptr);
  HRESULT result = E_PENDING;
  ComPtr<IAudioClient> client;
  ~ActivateHandler() override { CloseHandle(done); }
  STDMETHOD(ActivateCompleted)(IActivateAudioInterfaceAsyncOperation* op) override {
    HRESULT activate = E_UNEXPECTED;
    ComPtr<IUnknown> unk;
    HRESULT hr = op->GetActivateResult(&activate, &unk);
    result = FAILED(hr) ? hr : activate;
    if (SUCCEEDED(result)) result = unk.As(&client);
    SetEvent(done);
    return S_OK;
  }
};

WAVEFORMATEX outputFormat() {
  WAVEFORMATEX f{};
  f.wFormatTag = WAVE_FORMAT_PCM;
  f.nChannels = 1;
  f.nSamplesPerSec = kRate;
  f.wBitsPerSample = 16;
  f.nBlockAlign = 2;
  f.nAvgBytesPerSec = kRate * 2;
  return f;
}

HRESULT openProcessLoopback(DWORD pid, ComPtr<IAudioClient>& out) {
  AUDIOCLIENT_ACTIVATION_PARAMS params{};
  params.ActivationType = AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK;
  params.ProcessLoopbackParams.TargetProcessId = pid;
  params.ProcessLoopbackParams.ProcessLoopbackMode = PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE;
  PROPVARIANT prop{};
  prop.vt = VT_BLOB;
  prop.blob.cbSize = sizeof params;
  prop.blob.pBlobData = reinterpret_cast<BYTE*>(&params);

  auto handler = Make<ActivateHandler>();
  ComPtr<IActivateAudioInterfaceAsyncOperation> op;
  HRESULT hr = ActivateAudioInterfaceAsync(VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK, __uuidof(IAudioClient), &prop, handler.Get(), &op);
  if (FAILED(hr)) return hr;
  if (WaitForSingleObject(handler->done, 10000) != WAIT_OBJECT_0) return HRESULT_FROM_WIN32(WAIT_TIMEOUT);
  if (FAILED(handler->result)) return handler->result;
  WAVEFORMATEX fmt = outputFormat();
  hr = handler->client->Initialize(AUDCLNT_SHAREMODE_SHARED,
                                   AUDCLNT_STREAMFLAGS_LOOPBACK | AUDCLNT_STREAMFLAGS_EVENTCALLBACK | AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM,
                                   0, 0, &fmt, nullptr);
  if (SUCCEEDED(hr)) out = handler->client;
  return hr;
}

HRESULT openDeviceLoopback(const std::wstring& id, ComPtr<IAudioClient>& out) {
  ComPtr<IMMDeviceEnumerator> en;
  ComPtr<IMMDevice> dev;
  ComPtr<IAudioClient> client;
  HRESULT hr = CoCreateInstance(__uuidof(MMDeviceEnumerator), nullptr, CLSCTX_ALL, IID_PPV_ARGS(&en));
  if (SUCCEEDED(hr)) hr = en->GetDevice(id.c_str(), &dev);
  if (SUCCEEDED(hr)) hr = dev->Activate(__uuidof(IAudioClient), CLSCTX_ALL, nullptr, (void**)client.GetAddressOf());
  if (FAILED(hr)) return hr;
  WAVEFORMATEX fmt = outputFormat();
  hr = client->Initialize(AUDCLNT_SHAREMODE_SHARED,
                          AUDCLNT_STREAMFLAGS_LOOPBACK | AUDCLNT_STREAMFLAGS_EVENTCALLBACK | AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM |
                              AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY,
                          0, 0, &fmt, nullptr);
  if (SUCCEEDED(hr)) out = client;
  return hr;
}

// --- Capture ------------------------------------------------------------------

CRITICAL_SECTION g_commandLock;
std::string g_commandKey;  // empty = not capturing
uint64_t g_commandGen = 0;

void currentCommand(std::string& key, uint64_t& gen) {
  EnterCriticalSection(&g_commandLock);
  key = g_commandKey;
  gen = g_commandGen;
  LeaveCriticalSection(&g_commandLock);
}

class PcmChunker {
 public:
  void add(const int16_t* samples, size_t count) {  // samples == nullptr means silence
    while (count > 0) {
      size_t n = std::min<size_t>(count, kChunkFrames - used_);
      if (samples) { memcpy(buf_ + used_, samples, n * 2); samples += n; }
      else memset(buf_ + used_, 0, n * 2);
      used_ += n;
      count -= n;
      if (used_ == kChunkFrames) flush();
    }
  }
  void flush() {
    if (used_) writeFrame(2, buf_, (uint32_t)(used_ * 2));
    used_ = 0;
  }

 private:
  int16_t buf_[kChunkFrames];
  size_t used_ = 0;
};

enum class PumpEnd { Superseded, Lost };

PumpEnd pump(IAudioClient* client, HANDLE process, bool fillSilence, uint64_t gen, HRESULT& failure) {
  HANDLE sampleReady = CreateEventW(nullptr, FALSE, FALSE, nullptr);
  ComPtr<IAudioCaptureClient> capture;
  failure = client->SetEventHandle(sampleReady);
  if (SUCCEEDED(failure)) failure = client->GetService(IID_PPV_ARGS(&capture));
  if (SUCCEEDED(failure)) failure = client->Start();
  if (FAILED(failure)) { CloseHandle(sampleReady); return PumpEnd::Lost; }

  LARGE_INTEGER freq, lastAudio, now;
  QueryPerformanceFrequency(&freq);
  QueryPerformanceCounter(&lastAudio);

  PcmChunker out;
  HANDLE waits[3] = {sampleReady, g_captureChanged, process};
  DWORD waitCount = process ? 3 : 2;
  PumpEnd end = PumpEnd::Lost;
  for (;;) {
    DWORD w = WaitForMultipleObjects(waitCount, waits, FALSE, 50);
    if (w == WAIT_OBJECT_0 + 1) {
      std::string key;
      uint64_t current = 0;
      currentCommand(key, current);
      if (current != gen) { end = PumpEnd::Superseded; break; }
      continue;
    }
    if (w == WAIT_OBJECT_0 + 2) break;  // the target process exited

    UINT32 next = 0;
    HRESULT hr = capture->GetNextPacketSize(&next);
    bool gotAudio = false;
    while (SUCCEEDED(hr) && next > 0) {
      BYTE* data = nullptr;
      UINT32 frames = 0;
      DWORD flags = 0;
      hr = capture->GetBuffer(&data, &frames, &flags, nullptr, nullptr);
      if (FAILED(hr)) break;
      out.add((flags & AUDCLNT_BUFFERFLAGS_SILENT) ? nullptr : reinterpret_cast<const int16_t*>(data), frames);
      capture->ReleaseBuffer(frames);
      gotAudio = true;
      hr = capture->GetNextPacketSize(&next);
    }
    if (FAILED(hr)) { failure = hr; break; }  // endpoint removed or reformatted

    QueryPerformanceCounter(&now);
    if (gotAudio) {
      lastAudio = now;
    } else if (fillSilence) {
      double idleSec = double(now.QuadPart - lastAudio.QuadPart) / freq.QuadPart;
      if (idleSec * 1000 >= kSilenceFillAfterMs) {
        out.add(nullptr, size_t(idleSec * kRate));
        lastAudio = now;
      }
    }
  }
  out.flush();
  client->Stop();
  CloseHandle(sampleReady);
  return end;
}

void emitState(const char* state, const std::string& key, HRESULT hr = S_OK) {
  std::string s = std::string("{\"t\":\"state\",\"state\":\"") + state + "\",\"key\":" + json(key);
  if (FAILED(hr)) s += ",\"hr\":\"" + hex(hr) + "\"";
  emit(s + "}");
}

DWORD WINAPI captureThread(LPVOID) {
  CoInitializeEx(nullptr, COINIT_MULTITHREADED);
  DWORD task = 0;
  HANDLE av = AvSetMmThreadCharacteristicsW(L"Capture", &task);

  std::string lastState;
  auto setState = [&](const char* state, const std::string& key, HRESULT hr = S_OK) {
    std::string id = std::string(state) + "|" + key;
    if (id == lastState) return;
    lastState = id;
    emitState(state, key, hr);
  };

  for (;;) {
    std::string key;
    uint64_t gen = 0;
    currentCommand(key, gen);
    if (key.empty()) {
      setState("idle", "");
      WaitForSingleObject(g_captureChanged, INFINITE);
      continue;
    }

    ComPtr<IAudioClient> client;
    HANDLE process = nullptr;
    HRESULT hr = S_OK;
    bool found = false;
    DWORD pid = 0;
    std::wstring deviceId;
    EnterCriticalSection(&g_sourcesLock);
    if (key.rfind("app:", 0) == 0) {
      auto it = g_apps.find(key);
      if (it != g_apps.end()) { pid = it->second.rootPid; found = true; }
    } else {
      auto it = g_devices.find(key);
      if (it != g_devices.end()) { deviceId = it->second.id; found = true; }
    }
    LeaveCriticalSection(&g_sourcesLock);

    if (found && pid) {
      // Opened before activating: activation can't tell us the process is gone.
      process = OpenProcess(SYNCHRONIZE, FALSE, pid);
      if (!process || WaitForSingleObject(process, 0) == WAIT_OBJECT_0) found = false;
      else hr = openProcessLoopback(pid, client);
    } else if (found) {
      hr = openDeviceLoopback(deviceId, client);
    }

    if (!found || FAILED(hr)) {
      if (process) CloseHandle(process);
      setState("waiting", key, hr);
      WaitForSingleObject(g_captureChanged, kWaitingRetryMs);
      continue;
    }

    setState("capturing", key);
    HRESULT failure = S_OK;
    PumpEnd end = pump(client.Get(), process, process == nullptr, gen, failure);
    if (process) CloseHandle(process);
    client.Reset();
    if (end == PumpEnd::Lost) setState("waiting", key, failure);
  }
  if (av) AvRevertMmThreadCharacteristics(av);
  return 0;
}

DWORD WINAPI watchThread(LPVOID) {
  CoInitializeEx(nullptr, COINIT_MULTITHREADED);
  Watcher watcher;
  g_watcher = &watcher;
  watcher.run();
  return 0;
}

DWORD windowsBuild() {
  using Fn = LONG(WINAPI*)(OSVERSIONINFOW*);
  OSVERSIONINFOW v{sizeof v};
  auto fn = (Fn)GetProcAddress(GetModuleHandleW(L"ntdll.dll"), "RtlGetVersion");
  if (fn) fn(&v);
  return v.dwBuildNumber;
}

// Microsoft documents process loopback for 20348+, but it works from 19041, so the
// build is only a first filter and the real answer comes from trying it.
bool perAppSupported(DWORD build) {
  if (build < kMinProcessLoopbackBuild) return false;
  ComPtr<IAudioClient> client;
  return SUCCEEDED(openProcessLoopback(GetCurrentProcessId(), client));
}

void handleCommand(const std::string& line) {
  size_t space = line.find(' ');
  std::string verb = line.substr(0, space);
  std::string arg = space == std::string::npos ? "" : line.substr(space + 1);
  if (verb == "start" || verb == "stop") {
    EnterCriticalSection(&g_commandLock);
    g_commandKey = verb == "start" ? arg : "";
    g_commandGen++;
    LeaveCriticalSection(&g_commandLock);
    SetEvent(g_captureChanged);
  } else if (verb == "list") {
    if (g_watcher) g_watcher->force_ = true;
    SetEvent(g_relist);
  }
}

}  // namespace

int WINAPI wWinMain(HINSTANCE, HINSTANCE, PWSTR, int) {
  if (FAILED(CoInitializeEx(nullptr, COINIT_MULTITHREADED))) return 1;

  g_stdout = GetStdHandle(STD_OUTPUT_HANDLE);
  HANDLE in = GetStdHandle(STD_INPUT_HANDLE);
  InitializeCriticalSection(&g_outLock);
  InitializeCriticalSection(&g_sourcesLock);
  InitializeCriticalSection(&g_commandLock);
  g_relist = CreateEventW(nullptr, FALSE, FALSE, nullptr);
  g_captureChanged = CreateEventW(nullptr, FALSE, FALSE, nullptr);

  int argc = 0;
  LPWSTR* argv = CommandLineToArgvW(GetCommandLineW(), &argc);
  for (int i = 1; argv && i + 1 < argc; i++)
    if (std::wstring(argv[i]) == L"--exclude-exe") g_excludeExe = lower(argv[i + 1]);

  DWORD build = windowsBuild();
  char hello[80];
  snprintf(hello, sizeof hello, "{\"t\":\"hello\",\"build\":%lu,\"perApp\":%s}", build, perAppSupported(build) ? "true" : "false");
  emit(hello);

  CreateThread(nullptr, 0, watchThread, nullptr, 0, nullptr);
  CreateThread(nullptr, 0, captureThread, nullptr, 0, nullptr);

  // EOF means Electron closed the pipe or died, so stop recording and leave.
  std::string pending;
  char buf[1024];
  DWORD got = 0;
  while (ReadFile(in, buf, sizeof buf, &got, nullptr) && got > 0) {
    pending.append(buf, got);
    if (pending.size() > 64 * 1024) break;  // nothing legitimate is this long
    size_t nl;
    while ((nl = pending.find('\n')) != std::string::npos) {
      std::string line = pending.substr(0, nl);
      pending.erase(0, nl + 1);
      if (!line.empty() && line.back() == '\r') line.pop_back();
      if (!line.empty()) handleCommand(line);
    }
  }
  ExitProcess(0);
}
