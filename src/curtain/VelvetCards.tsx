import { ArrowDown, ArrowUpRight } from "lucide-react";
import { RouteLink } from "./App";
const cards = [
  {
    id: "velvet-swap",
    number: "01",
    act: "THE FIRST NOTE",
    name: "Swap",
    image: "/__l5e/assets-v1/94329eb2-ae7d-463c-a6be-a490597a115f/private-stage-clean.png",
    alt: "Text-free navy and antique-gold oil painting of a private theatre",
    title: (
      <>
        Some positions
        <br />
        deserve <em>privacy.</em>
      </>
    ),
    copy: "Swap Stock Tokens and USDG privately. Choose a recipient and let Curtain deliver instantly or inside a private delay window.",
    detail: "Stock Tokens + USDG",
    cta: "Swap privately",
    to: "/app/swap",
  },
  {
    id: "velvet-compose",
    number: "02",
    act: "THE COMPLETE PERFORMANCE",
    name: "Stake",
    image: "/__l5e/assets-v1/71c0cc35-6678-4d57-aca2-eb69c3b54b47/opening-act-clean.png",
    alt: "Two Renaissance performers under warm light on an ornate navy and gold theatre stage, without lettering",
    title: (
      <>
        Every movement.
        <br />
        <em>One complete act.</em>
      </>
    ),
    copy: "Stake for 30, 90 or 180 days and earn at 1×, 1.5× or 2×. Your position earns rewards while you wait for your next act.",
    detail: "30d 1× · 90d 1.5× · 180d 2×",
    cta: "Explore rewards",
    to: "/app/stake",
  },
  {
    id: "velvet-ticket",
    number: "03",
    act: "BY YOUR INVITATION",
    name: "Your ticket",
    image: "/__l5e/assets-v1/3a85e301-5839-4847-acd8-27a62c0db4ef/invitation-clean.png",
    alt: "A gloved hand extending a sealed ivory envelope through a gilded frame on a navy wall, without lettering",
    title: (
      <>
        The right audience.
        <br />
        <em>By your choice.</em>
      </>
    ),
    copy: "Keep your escape ticket. If a swap misses its deadline, your depositing wallet can take the deposit back directly on-chain, even when Curtain’s service is unavailable.",
    detail: "Your ticket · Your deposit",
    cta: "View activity",
    to: "/app/activity",
  },
];
export default function VelvetCards() {
  return (
    <section className="section protocol velvet-section" id="protocol">
      <div className="velvet-heading">
        <div>
          <p className="section-number">
            ACT II <span>THE ART OF THE PROTOCOL</span>
          </p>
          <h2>
            Behind the velvet.
            <br />
            <em>A closer look.</em>
          </h2>
        </div>
        <div className="velvet-introduction">
          <p>
            Three scenes.
            <br />A more private way to move.
          </p>
          <span>
            SCROLL TO TURN THE SCENE <ArrowDown size={15} />
          </span>
        </div>
      </div>
      <nav className="velvet-contents" aria-label="Behind the velvet scenes">
        {cards.map((c) => (
          <a key={c.id} href={"#" + c.id}>
            <span>{c.number}</span>
            {c.name}
            <ArrowDown size={13} />
          </a>
        ))}
      </nav>
      <div className="velvet-card-stack">
        {cards.map((c, i) => (
          <article
            id={c.id}
            className={`velvet-card velvet-card-${i + 1}`}
            key={c.id}
            style={{ "--card-index": i } as React.CSSProperties}
          >
            <img className="velvet-card-art" src={c.image} alt={c.alt} loading="lazy" />
            <div className="velvet-card-shade" />
            <div className="velvet-card-top">
              <span>CURTAIN / {c.act}</span>
              <span>{c.number} — 03</span>
            </div>
            <div className="velvet-card-copy">
              <p className="eyebrow">{c.name}</p>
              <h3>{c.title}</h3>
              <p>{c.copy}</p>
              <RouteLink to={c.to} className="underlined-link">
                {c.cta}
                <ArrowUpRight size={17} />
              </RouteLink>
            </div>
            <div className="velvet-card-bottom">
              <span>{c.detail}</span>
              <span className="velvet-scene-number">{["I", "II", "III"][i]}</span>
            </div>
          </article>
        ))}
      </div>
      <div className="velvet-afterword">
        <span>BUILT WITH INTENTION</span>
        <p>
          Private swaps. An on-chain escape hatch.
          <br />
          Privacy with considered mechanics underneath.
        </p>
        <a href="#questions">
          Read the details <ArrowUpRight size={14} />
        </a>
      </div>
    </section>
  );
}
