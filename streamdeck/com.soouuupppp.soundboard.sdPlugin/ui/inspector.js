// Shared by the settings panels: shows whether the Soundboard desktop app is reachable
// and opens the help page. sdpi-components (vendored next to this file) handles the
// settings themselves and asks the plugin for live lists via `datasource`.
(function () {
  const client = window.SDPIComponents.streamDeckClient;
  const status = document.getElementById("status");

  function render(p) {
    if (!status) return;
    status.classList.remove("ok", "warn");
    if (!p.connected) {
      status.textContent = "Open the Soundboard desktop app.";
      status.classList.add("warn");
    } else if (!p.available) {
      status.textContent = "Connected. Open the dashboard in Soundboard to load your list.";
      status.classList.add("warn");
    } else {
      status.textContent = "Connected to Soundboard.";
      status.classList.add("ok");
    }
  }

  client.sendToPropertyInspector.subscribe((msg) => {
    const p = msg && msg.payload;
    if (p && p.event === "status") render(p);
  });
  client.send("sendToPlugin", { event: "getStatus" });

  const help = document.getElementById("help");
  if (help) {
    help.addEventListener("click", (e) => {
      e.preventDefault();
      client.send("sendToPlugin", { event: "openHelp" });
    });
  }
})();
