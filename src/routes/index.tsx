import { createFileRoute } from "@tanstack/react-router";
import CurtainApp from "@/components/CurtainApp";

const description =
  "Curtain. A private stage for tokenized stocks and USDG. Shield assets, compose private DeFi, and choose what you disclose.";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Curtain — Where privacy takes center stage" },
      { name: "description", content: description },
      { property: "og:title", content: "Curtain — Where privacy takes center stage" },
      { property: "og:description", content: description },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: CurtainApp,
});
