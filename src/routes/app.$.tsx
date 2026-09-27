import { createFileRoute } from "@tanstack/react-router";
import CurtainApp from "@/components/CurtainApp";

const description =
  "Your private box. Shield and unshield supported assets, compose private DeFi recipes, prepare scoped disclosure, and review every plan before you act.";

export const Route = createFileRoute("/app/$")({
  head: () => ({
    meta: [
      { title: "Curtain — Your private box" },
      { name: "description", content: description },
      { property: "og:title", content: "Curtain — Your private box" },
      { property: "og:description", content: description },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: CurtainApp,
});
