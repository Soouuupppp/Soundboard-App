"use client";

// Signed-in header (1.4.1 navbar refactor). A 3-column grid so the center group
// is truly centered regardless of the side clusters' widths:
//   left   — logo + "Soundboard"
//   center — output meter → Voice changer → Sound Effects   (hidden on small screens)
//   right  — a square Settings cog + profile dropdown (both standalone, matching the
//            center chips' height), then a user-dropdown / quota stack: the username
//            on top with the upload-storage quota as a thin bar beneath it (sized to
//            a fixed min/max-width band so it stays consistent across name lengths).
// The Settings cog shares the one-open-at-a-time `panel` state owned here with the
// center Voice/FX popovers.

import { useState } from "react";
import Link from "next/link";
import Image from "next/image";
import { CenterControls, SettingsControl, type Panel } from "@/components/HeaderControls";
import { UserMenu } from "@/components/UserMenu";
import { ProfileSwitcher } from "@/components/ProfileSwitcher";
import { QuotaBar } from "@/components/QuotaBar";
import logo from "@/app/logo.png";

export function AppHeader({
  name,
  image,
  isAdmin,
  signOutAction,
}: {
  name: string | null;
  image: string | null;
  isAdmin: boolean;
  signOutAction: () => void;
}) {
  const [panel, setPanel] = useState<Panel>(null);
  const toggle = (p: Exclude<Panel, null>) => setPanel((cur) => (cur === p ? null : p));
  const close = () => setPanel(null);

  return (
    <div className="max-w-[1800px] mx-auto px-4 py-2.5 grid grid-cols-[auto_1fr_auto] items-center gap-4">
      {/* Left — logo */}
      <Link href="/" className="font-semibold tracking-tight flex items-center gap-2">
        <Image src={logo} alt="Soundboard logo" width={32} height={32} priority className="h-8 w-8" />
        <span className="hidden sm:inline">Soundboard</span>
      </Link>

      {/* Center — audio controls (collapse on small screens) */}
      <div className="hidden sm:flex items-center justify-center">
        <CenterControls panel={panel} toggle={toggle} close={close} />
      </div>

      {/* Right cluster — Profile · Settings cog · user/quota stack, grouped
          together (the user/quota band is left-aligned: name beside the avatar,
          quota bar spanning beneath). */}
      <div className="flex items-center gap-2">
        <ProfileSwitcher />
        <SettingsControl panel={panel} toggle={toggle} close={close} />
        <div className="flex flex-col items-start gap-1 min-w-[12rem] max-w-[16rem]">
          <div className="flex items-center text-sm w-full">
            <UserMenu name={name} image={image} isAdmin={isAdmin} signOutAction={signOutAction} />
          </div>
          <QuotaBar className="hidden sm:block w-full" />
        </div>
      </div>
    </div>
  );
}
