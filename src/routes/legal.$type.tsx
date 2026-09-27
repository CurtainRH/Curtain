import { createFileRoute } from "@tanstack/react-router";
import CurtainApp from "@/components/CurtainApp";

const description =
  "Curtain's fine print: privacy notice, terms of use, and risk disclosure for the private stage.";

export const Route = createFileRoute("/legal/$type")({
  head: () => ({
    meta: [
      { title: "Curtain — Legal" },
      { name: "description", content: description },
      { property: "og:title", content: "Curtain — Legal" },
      { property: "og:description", content: description },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: CurtainApp,
});
