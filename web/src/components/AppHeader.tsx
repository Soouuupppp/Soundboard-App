"use client";

// Signed-in header (1.4.1 navbar refactor). A 3-column grid so the center group
// is truly centered regardless of the side clusters' widths:
//   left   — logo + "Soundboard"
//   center — output meter → Voice changer → Sound Effects   (hidden on small screens)
//   right  — Settings cog → user dropdown → profile dropdown,
//            with the upload-storage quota as a thin bar spanning beneath them.
// The Settings cog sits in the right cluster but shares the one-open-at-a-time
// `panel` state owned here with the center Voice/FX popovers.

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

      {/* Right cluster — Settings · user · profile, quota bar spanning beneath */}
      <div className="flex flex-col items-stretch gap-1">
        <div className="flex items-center justify-end gap-2 text-sm">
          <SettingsControl panel={panel} toggle={toggle} close={close} />
          <UserMenu name={name} image={image} isAdmin={isAdmin} signOutAction={signOutAction} />
          <ProfileSwitcher />
        </div>
        <QuotaBar className="hidden sm:block w-full" />
      </div>
    </div>
  );
}
