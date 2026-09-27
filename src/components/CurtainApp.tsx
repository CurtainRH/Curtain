import { ClientOnly } from "@tanstack/react-router";
import { lazy, Suspense } from "react";

const CurtainExperience = lazy(() => import("@/curtain/entry"));

/**
 * The Curtain experience owns its own in-page navigation, audio, GSAP curtain
 * transitions and wallet reads, so it renders in the browser only.
 */
export default function CurtainApp() {
  return (
    <ClientOnly fallback={<div style={{ minHeight: "100vh", background: "#091323" }} />}>
      <Suspense fallback={<div style={{ minHeight: "100vh", background: "#091323" }} />}>
        <CurtainExperience />
      </Suspense>
    </ClientOnly>
  );
}
