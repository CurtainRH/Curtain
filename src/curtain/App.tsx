import {
  useState,
  useEffect,
  useRef,
  useCallback,
  createContext,
  useContext,
  type ReactNode,
} from "react";
import {
  ArrowUpRight,
  ArrowRight,
  ArrowDown,
  X,
  Play,
  Pause,
  ShieldCheck,
  LockKeyhole,
  Fingerprint,
  Layers3,
  Wallet,
  Menu,
  Github,
  Send,
  ChevronDown,
  Check,
  Copy,
} from "lucide-react";
import { gsap } from "gsap";
import Dashboard from "./Dashboard";
import { ensureChain, errorMessage, provider } from "./integration";
import Legal from "./Legal";
import VelvetCards from "./VelvetCards";
import { TheatreEntrance, SceneStory, ActProgramme, Soundscape } from "./StageExperience";

type ModalState =
  | { kind: "coming"; name: string }
  | { kind: "film"; film: "overture" | "technology" }
  | { kind: "wallet" }
  | null;
type NavContextType = {
  navigate: (path: string) => void;
  popup: (name: string) => void;
  wallet: string;
  connect: () => void;
};
const NavContext = createContext<NavContextType>({
  navigate: () => {},
  popup: () => {},
  wallet: "",
  connect: () => {},
});
export const useNav = () => useContext(NavContext);
export function Logo({ compact = false }: { compact?: boolean }) {
  return (
    <span className={`brand ${compact ? "compact" : ""}`}>
      <span className="brand-mark">
        <img
          src="/__l5e/assets-v1/677f9849-19e8-4118-863a-a09648689d5c/curtain-logo-exact.png"
          width="448"
          height="571"
          alt={compact ? "Curtain" : ""}
        />
      </span>
      {!compact && <span className="brand-name">Curtain</span>}
    </span>
  );
}
export function RouteLink({
  to,
  children,
  className = "",
  onAfter,
}: {
  to: string;
  children: ReactNode;
  className?: string;
  onAfter?: () => void;
}) {
  const { navigate } = useNav();
  return (
    <a
      href={to}
      className={className}
      onClick={(e) => {
        if (e.metaKey || e.ctrlKey || e.shiftKey) return;
        e.preventDefault();
        onAfter?.();
        navigate(to);
      }}
    >
      {children}
    </a>
  );
}
export function Socials() {
  const { popup } = useNav();
  return (
    <div className="socials">
      <button aria-label="Telegram" onClick={() => popup("Telegram")}>
        <Send size={18} />
      </button>
      <button aria-label="X" onClick={() => popup("X")}>
        <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor">
          <path d="M18.9 2H22l-6.8 7.8L23.2 22h-6.3L12 14.6 5.5 22H2.4l8.1-9.3L.8 2h6.5l4.5 6.8L18.9 2Zm-1.1 18h1.7L6.3 3.9H4.5L17.8 20Z" />
        </svg>
      </button>
      <button aria-label="GitHub" onClick={() => popup("GitHub")}>
        <Github size={19} />
      </button>
    </div>
  );
}
function useDialog(open: boolean, ref: React.RefObject<HTMLDialogElement | null>) {
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (open) {
      el.showModal();
      const old = document.body.style.overflow;
      document.body.style.overflow = "hidden";
      return () => {
        el.close();
        document.body.style.overflow = old;
      };
    }
    return undefined;
  }, [open, ref]);
}
function Modal({
  modal,
  close,
  connectWallet,
  error,
}: {
  modal: ModalState;
  close: () => void;
  connectWallet: () => Promise<void>;
  error: string;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useDialog(!!modal, ref);
  if (!modal) return null;
  return (
    <dialog
      ref={ref}
      className={`modal ${modal.kind === "film" ? "film-modal" : ""}`}
      onCancel={close}
      onClick={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      <button className="modal-close" aria-label="Close dialog" onClick={close}>
        <X />
      </button>
      {modal.kind === "film" ? (
        <>
          <p className="eyebrow">A CURTAIN PRODUCTION</p>
          <video
            key={modal.film}
            autoPlay
            controls
            playsInline
            preload="metadata"
            src={
              modal.film === "technology"
                ? "/__l5e/assets-v1/d16e55a0-0730-443b-9ccc-ef7c7f1eddc2/curtain-invitation-15s.mp4"
                : "/__l5e/assets-v1/2424dcdf-58c9-41af-aedc-2e0ccf6f574c/overture-web.mp4"
            }
          >
            <track
              kind="captions"
              src={
                modal.film === "technology"
                  ? "/__l5e/assets-v1/a58b4a39-f4d4-4887-98bd-54e2a7fcc2e3/invitation-en.vtt"
                  : "/__l5e/assets-v1/f030b853-6e96-477e-ab98-9f27a854fed6/overture-en.vtt"
              }
              srcLang="en"
              label="English"
            />
          </video>
          <h2>
            {modal.film === "technology" ? "The invitation." : "Where privacy takes center stage."}
          </h2>
          {modal.film === "technology" && (
            <>
              <p className="film-description">THE INVITATION · A CURTAIN SCENE · 15 SECONDS</p>
              <details>
                <summary>Read the dialogue</summary>
                <p>
                  <strong>Scholar:</strong> Must everyone see my portfolio?
                </p>
                <p>
                  <strong>Herald:</strong> Curtain delivers private swaps with considered timing.
                </p>
                <p>
                  <strong>Scholar:</strong> And the invitation?
                </p>
                <p>
                  <strong>Herald:</strong> You choose the recipient and the delay.
                </p>
              </details>
            </>
          )}
        </>
      ) : modal.kind === "coming" ? (
        <>
          <Logo compact />
          <p className="eyebrow">THE NEXT ACT</p>
          <h2>Coming soon.</h2>
          <p>
            {modal.name} is waiting in the wings.
            <br />
            We’ll open the curtain when it’s ready.
          </p>
          <button className="button gold" onClick={close}>
            Back to the stage <ArrowRight size={16} />
          </button>
        </>
      ) : (
        <>
          <Logo compact />
          <p className="eyebrow">YOUR PRIVATE ENTRANCE</p>
          <h2>Connect your wallet.</h2>
          <p>
            Connect your browser wallet to swap privately and manage your rewards on Robinhood
            Chain.
          </p>
          <button className="button gold" onClick={connectWallet}>
            <Wallet size={18} /> Browser wallet <ArrowUpRight size={16} />
          </button>
          {error && (
            <p role="alert" className="form-error">
              {error}
            </p>
          )}
          <p className="small muted">
            Connecting never gives Curtain permission to move your assets.
          </p>
        </>
      )}
    </dialog>
  );
}
const menuItems = [
  {
    n: "I",
    title: "The overture",
    sub: "Discover Curtain",
    to: "/",
    img: "/__l5e/assets-v1/5b32431e-fca2-47ce-bf64-34f653c8a1c6/theatre.png",
  },
  {
    n: "II",
    title: "Your private box",
    sub: "Enter the application",
    to: "/app",
    img: "/__l5e/assets-v1/94329eb2-ae7d-463c-a6be-a490597a115f/private-stage-clean.png",
  },
  {
    n: "III",
    title: "The protocol",
    sub: "Understand the mechanics",
    to: "/#protocol",
    img: "/__l5e/assets-v1/71c0cc35-6678-4d57-aca2-eb69c3b54b47/opening-act-clean.png",
  },
  {
    n: "IV",
    title: "The fine print",
    sub: "Terms & privacy",
    to: "/legal/terms",
    img: "/__l5e/assets-v1/3a85e301-5839-4847-acd8-27a62c0db4ef/invitation-clean.png",
  },
];
export default function App() {
  const [path, setPath] = useState(location.pathname);
  const [menu, setMenu] = useState(false);
  const [modal, setModal] = useState<ModalState>(null);
  const [wallet, setWallet] = useState("");
  const [error, setError] = useState("");
  const [motion, setMotion] = useState(() => {
    try {
      return localStorage.getItem("curtain-motion") !== "off";
    } catch {
      return true;
    }
  });
  const page = useRef<HTMLDivElement>(null);
  const transition = useRef<HTMLDivElement>(null);
  const transitioning = useRef(false);
  const reduced = useCallback(
    () => !motion || matchMedia("(prefers-reduced-motion: reduce)").matches,
    [motion],
  );
  const navigate = useCallback(
    (to: string) => {
      const [next, anchor] = to.split("#");
      const target = next || location.pathname;
      setMenu(false);
      if (target === location.pathname) {
        if (anchor)
          setTimeout(
            () =>
              document
                .getElementById(anchor)
                ?.scrollIntoView({ behavior: reduced() ? "auto" : "smooth" }),
            520,
          );
        else window.scrollTo({ top: 0, behavior: "smooth" });
        return;
      }
      if (transitioning.current) return;
      transitioning.current = true;
      const swap = () => {
        history.pushState({}, "", to);
        setPath(target);
        window.scrollTo(0, 0);
        document.title = target.startsWith("/app")
          ? "Curtain — Your private box"
          : target.startsWith("/legal")
            ? "Curtain — Legal"
            : "Curtain — Where privacy takes center stage";
        if (anchor) setTimeout(() => document.getElementById(anchor)?.scrollIntoView(), 60);
      };
      if (reduced()) {
        swap();
        transitioning.current = false;
        return;
      }
      const el = transition.current!;
      gsap.set(el, { visibility: "visible" });
      gsap
        .timeline({
          onComplete: () => {
            gsap.set(el, { visibility: "hidden" });
            transitioning.current = false;
            document.querySelector<HTMLElement>("main h1")?.focus({ preventScroll: true });
          },
        })
        .fromTo(
          el.querySelector(".curtain-left"),
          { xPercent: -101 },
          { xPercent: 0, duration: 0.55, ease: "power2.inOut" },
          0,
        )
        .fromTo(
          el.querySelector(".curtain-right"),
          { xPercent: 101 },
          { xPercent: 0, duration: 0.55, ease: "power2.inOut" },
          0,
        )
        .call(swap)
        .to(
          el.querySelector(".curtain-left"),
          { xPercent: -101, duration: 0.75, ease: "power3.inOut" },
          "+=.14",
        )
        .to(
          el.querySelector(".curtain-right"),
          { xPercent: 101, duration: 0.75, ease: "power3.inOut" },
          "<",
        );
    },
    [reduced],
  );
  useEffect(() => {
    const pop = () => {
      setPath(location.pathname);
      setMenu(false);
      window.scrollTo(0, 0);
    };
    window.addEventListener("popstate", pop);
    return () => window.removeEventListener("popstate", pop);
  }, []);
  useEffect(() => {
    document.documentElement.dataset["motion"] = motion ? "on" : "off";
    try {
      localStorage.setItem("curtain-motion", motion ? "on" : "off");
    } catch {
      /* Motion still works when storage is unavailable. */
    }
  }, [motion]);
  useEffect(() => {
    if (!menu) return;
    const previous = document.activeElement as HTMLElement | null;
    const container = document.getElementById("curtain-menu");
    const focusable = () => Array.from(container?.querySelectorAll<HTMLElement>("a,button") || []);
    const timer = setTimeout(() => focusable()[0]?.focus(), 30);
    const keys = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenu(false);
      if (e.key === "Tab") {
        const list = focusable(),
          first = list[0],
          last = list.at(-1);
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last?.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first?.focus();
        }
      }
    };
    document.addEventListener("keydown", keys);
    const old = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      clearTimeout(timer);
      document.removeEventListener("keydown", keys);
      document.body.style.overflow = old;
      previous?.focus();
    };
  }, [menu]);
  useEffect(() => {
    if (menu) return;
    const timer = setTimeout(() => page.current?.style.setProperty("--menu-crop", "0px"), 520);
    return () => clearTimeout(timer);
  }, [menu]);
  useEffect(() => {
    const elements = document.querySelectorAll(".reveal");
    const observer = new IntersectionObserver(
      (entries) =>
        entries.forEach((e) => {
          if (e.isIntersecting) {
            e.target.classList.add("seen");
            observer.unobserve(e.target);
          }
        }),
      { threshold: 0.1 },
    );
    elements.forEach((e) => observer.observe(e));
    return () => observer.disconnect();
  }, [path]);
  useEffect(() => {
    const walletProvider = provider();
    if (!walletProvider?.on) return;
    const change = (accounts: string[]) => setWallet(accounts[0] || "");
    walletProvider.on("accountsChanged", change);
    return () => walletProvider.removeListener?.("accountsChanged", change);
  }, []);
  const connectWallet = async () => {
    setError("");
    const walletProvider = provider();
    if (!walletProvider) {
      setError(
        "No browser wallet was found. Open Curtain in a browser with your wallet installed.",
      );
      return;
    }
    try {
      const accounts = await walletProvider.request({ method: "eth_requestAccounts" });
      if (accounts?.[0]) {
        await ensureChain();
        setWallet(accounts[0]);
        setModal(null);
      }
    } catch (e) {
      setError(errorMessage(e));
    }
  };
  return (
    <NavContext.Provider
      value={{
        navigate,
        popup: (name) => setModal({ kind: "coming", name }),
        wallet,
        connect: () => {
          setError("");
          setModal({ kind: "wallet" });
        },
      }}
    >
      <a href="#main" className="skip-link">
        Skip to content
      </a>
      <div className={`website ${menu ? "menu-open" : ""}`}>
        <div ref={page} className="page-stage" inert={menu ? true : undefined}>
          <header className={`header ${path.startsWith("/app") ? "app-header" : ""}`}>
            <RouteLink to="/" className="brand-link">
              <Logo />
            </RouteLink>
            <nav className="header-links" aria-label="Main navigation">
              <RouteLink to="/#experience">The experience</RouteLink>
              <RouteLink to="/#protocol">The protocol</RouteLink>
              <RouteLink to="/app">
                Private box <ArrowUpRight size={13} />
              </RouteLink>
            </nav>
            <div className="header-actions">
              <span className="chain-tag">ROBINHOOD CHAIN</span>
              <button
                className="menu-button"
                aria-expanded={menu}
                aria-controls="curtain-menu"
                onClick={() => {
                  if (page.current)
                    page.current.style.setProperty(
                      "--menu-crop",
                      `${Math.max(0, page.current.offsetHeight - innerHeight - scrollY)}px`,
                    );
                  setMenu(true);
                }}
              >
                Menu <Menu size={18} />
              </button>
            </div>
          </header>
          {path.startsWith("/app") ? (
            <Dashboard path={path} />
          ) : path.startsWith("/legal/") ? (
            <Legal type={path.split("/").pop() || "terms"} />
          ) : path === "/" ? (
            <Landing watch={(film) => setModal({ kind: "film", film })} />
          ) : (
            <main id="main" className="not-found">
              <p className="eyebrow">AN UNSCRIPTED ENTRANCE</p>
              <h1 tabIndex={-1}>This act is yet to be written.</h1>
              <RouteLink to="/" className="button gold">
                Return to Curtain <ArrowRight size={18} />
              </RouteLink>
            </main>
          )}
          {!path.startsWith("/app") && <Footer />}
        </div>
        <nav
          id="curtain-menu"
          className="curtain-menu"
          aria-label="Theatre navigation"
          inert={!menu ? true : undefined}
        >
          <div className="menu-heading">
            <span className="eyebrow">CHOOSE YOUR NEXT ACT</span>
            <button className="text-button" onClick={() => setMenu(false)}>
              Close <X size={19} />
            </button>
          </div>
          <div className="menu-cards">
            {menuItems.map((m) => (
              <RouteLink key={m.n} to={m.to} className="menu-card">
                <span>
                  {m.n} <ArrowUpRight size={17} />
                </span>
                <div className="menu-image">
                  <img src={m.img} alt="" />
                </div>
                <h2>{m.title}</h2>
                <p>{m.sub}</p>
              </RouteLink>
            ))}
          </div>
        </nav>
      </div>
      <div className="route-curtain" ref={transition} aria-hidden="true">
        <div className="curtain-left" />
        <div className="curtain-right" />
        <span className="transition-seal">
          <Logo compact />
        </span>
      </div>
      <button
        className="motion-toggle"
        aria-label={motion ? "Pause ambient motion" : "Enable ambient motion"}
        onClick={() => setMotion((m) => !m)}
      >
        {motion ? <Pause size={12} /> : <Play size={12} />}
        <span>Motion {motion ? "on" : "off"}</span>
      </button>
      <Modal
        modal={modal}
        close={() => setModal(null)}
        connectWallet={connectWallet}
        error={error}
      />
    </NavContext.Provider>
  );
}
function Landing({ watch }: { watch: (film: "overture" | "technology") => void }) {
  const hero = useRef<HTMLElement>(null);
  const [faq, setFaq] = useState<number | null>(0);
  const faqs = [
    [
      "What is Curtain?",
      "Curtain brings private swaps and stake-to-earn to Robinhood Chain. Lending is coming soon.",
    ],
    [
      "How does a private swap work?",
      "Deposit a supported token and choose an output token and recipient. Curtain swaps through Uniswap and delivers the output instantly or within a random delay window.",
    ],
    [
      "Why choose a private delay?",
      "Curtain pays out at a random time inside your chosen window, up to 180 days. Longer windows and fresh recipient addresses give more privacy.",
    ],
    [
      "Can I get my deposit back?",
      "Save your escape ticket. If your swap has not been delivered by its deadline, you can request a refund three minutes later and finish it after a ten-minute challenge window. This works directly on-chain even when Curtain’s service is unavailable.",
    ],
    [
      "What are the protocol fees?",
      "Private swaps charge a 0.20% protocol fee and a 0.05% keeper fee. The live quote shows expected output after fees. Network costs are separate.",
    ],
    [
      "How do rewards work?",
      "When $CRTN launches, stake for 30, 90 or 180 days to earn at 1×, 1.5× or 2×. After unlocking, positions earn at 1× until withdrawn and restaked.",
    ],
  ];
  return (
    <>
      <TheatreEntrance />
      <ActProgramme />
      <Soundscape />
      <main id="main">
        <section
          id="top"
          className="hero"
          ref={hero}
          onPointerMove={(e) => {
            if (
              document.documentElement.dataset["motion"] === "off" ||
              matchMedia("(prefers-reduced-motion: reduce)").matches
            )
              return;
            const r = e.currentTarget.getBoundingClientRect();
            e.currentTarget.style.setProperty("--mx", `${(e.clientX / r.width - 0.5) * 8}px`);
            e.currentTarget.style.setProperty("--my", `${(e.clientY / r.height - 0.5) * 5}px`);
          }}
        >
          <div className="hero-scenery" />
          <div className="hero-vignette" />
          <div className="dust" />
          <div className="hero-copy">
            <p className="eyebrow">
              <span /> PRIVATE FINANCE. A NEW ACT. <span />
            </p>
            <h1 tabIndex={-1}>
              Your wealth.
              <br />
              <em>Your private stage.</em>
            </h1>
            <p className="hero-description">
              Stock Tokens. Private swaps. Rewards for your next act.
              <br />
              Enter a world where privacy takes center stage.
            </p>
            <div className="hero-ctas">
              <RouteLink to="/app" className="button gold">
                Enter the application <ArrowUpRight size={18} />
              </RouteLink>
              <button className="film-button" onClick={() => watch("overture")}>
                <span>
                  <Play size={13} fill="currentColor" />
                </span>
                Watch the overture <small>00:25</small>
              </button>
            </div>
          </div>
          <div className="hero-bottom">
            <span>BUILT FOR ROBINHOOD CHAIN</span>
            <a href="#experience" className="scroll-cue">
              THE STORY UNFOLDS <ArrowDown size={15} />
            </a>
            <span>EST. MMXXVI</span>
          </div>
        </section>
        <section className="spec-ribbon" aria-label="Protocol design">
          <div>
            <strong>
              0.20<em>%</em>
            </strong>
            <span>Protocol fee</span>
          </div>
          <div>
            <strong>
              180<em>days</em>
            </strong>
            <span>Optional delay window</span>
          </div>
          <div>
            <strong>
              2<em>×</em>
            </strong>
            <span>Staking rewards</span>
          </div>
          <div>
            <strong>
              Your<em>choice</em>
            </strong>
            <span>Selectively disclosable</span>
          </div>
        </section>
        <section className="section introduction" id="experience">
          <div className="section-number reveal">
            ACT I <span>THE RIGHT TO PRIVACY</span>
          </div>
          <div className="intro-grid">
            <div className="intro-heading reveal">
              <h2>
                A public market.
                <br />
                <em>A private position.</em>
              </h2>
              <p>
                The world can know the market.
                <br />
                It doesn’t need to know your every move.
              </p>
              <div className="ornament">✦</div>
            </div>
            <div className="intro-copy reveal">
              <p className="lead">Your portfolio deserves a private box.</p>
              <p>
                Curtain brings private swaps for tokenized stocks and USDG, with optional delays and
                control over your recipient.
              </p>
              <p>
                Choose your timing. Put your assets to work. Keep your escape ticket in your own
                hands.
              </p>
              <RouteLink to="/app" className="underlined-link">
                Take your place <ArrowUpRight size={17} />
              </RouteLink>
            </div>
          </div>
          <SceneStory />
        </section>
        <VelvetCards />
        <section className="cinema-section">
          <div className="cinema-image" />
          <div className="cinema-copy reveal">
            <span className="eyebrow">THE SECOND ACT / A CURTAIN PRODUCTION</span>
            <h2>
              The art is privacy.
              <br />
              <em>The craft is code.</em>
            </h2>
            <p className="cinema-caption">
              One envelope. A private exchange. An invitation that stays yours to give.
            </p>
            <button
              className="cinema-play"
              onClick={() => watch("technology")}
              aria-label="Play Curtain technology film"
            >
              <Play size={25} fill="currentColor" />
            </button>
            <p>THE INVITATION — 15 SECONDS</p>
            <div className="film-chapters">
              <span>A PRIVATE BOX</span>
              <span>A PRIVATE EXCHANGE</span>
              <span>YOUR INVITATION</span>
            </div>
          </div>
        </section>
        <section id="private-box" className="section private-box">
          <div className="section-number reveal">
            ACT III <span>YOUR PRIVATE BOX</span>
          </div>
          <div className="box-grid">
            <div className="reveal">
              <h2>
                The whole performance.
                <br />
                <em>One private view.</em>
              </h2>
              <p>
                Every swap, every position, every reward.
                <br />A considered workspace for the way you move.
              </p>
              <ul className="check-list">
                <li>
                  <Check size={16} />
                  Swap supported assets privately
                </li>
                <li>
                  <Check size={16} />
                  Choose an instant payout or private delay
                </li>
                <li>
                  <Check size={16} />
                  Stake to earn rewards
                </li>
                <li>
                  <Check size={16} />
                  Keep your activity in view
                </li>
              </ul>
              <RouteLink to="/app" className="button gold">
                Enter your private box <ArrowUpRight size={18} />
              </RouteLink>
            </div>
            <div className="box-preview reveal">
              <div className="preview-bar">
                <Logo />
                <span>PRIVATE BOX / 01</span>
              </div>
              <div className="preview-body">
                <span className="eyebrow">YOUR PORTFOLIO, ON YOUR TERMS</span>
                <h3>
                  A quieter kind
                  <br />
                  of control.
                </h3>
                <div className="preview-orbit">
                  <Logo compact />
                  <span className="orbit-label o1">SWAP</span>
                  <span className="orbit-label o2">STAKE</span>
                  <span className="orbit-label o3">ACTIVITY</span>
                </div>
                <div className="preview-bottom">
                  <LockKeyhole size={14} />
                  <span>You hold the keys.</span>
                  <ArrowUpRight size={16} />
                </div>
              </div>
            </div>
          </div>
        </section>
        <section className="section faq-section" id="questions">
          <div className="faq-heading reveal">
            <p className="eyebrow">BEFORE THE CURTAIN RISES</p>
            <h2>
              A little
              <br />
              <em>more clarity.</em>
            </h2>
          </div>
          <div className="faq-list">
            {faqs.map(([q, a], i) => (
              <div className="faq-item" key={q}>
                <button
                  aria-expanded={faq === i}
                  aria-controls={`faq-${i}`}
                  onClick={() => setFaq(faq === i ? null : i)}
                >
                  <span>{q}</span>
                  <ChevronDown size={18} className={faq === i ? "rotated" : ""} />
                </button>
                <div id={`faq-${i}`} hidden={faq !== i}>
                  <p>{a}</p>
                </div>
              </div>
            ))}
          </div>
        </section>
        <section className="final-invitation reveal">
          <div className="fine-line" />
          <Logo compact />
          <span className="eyebrow">YOUR NEXT ACT BEGINS HERE</span>
          <h2>Draw the curtain.</h2>
          <p>Where privacy takes center stage.</p>
          <RouteLink to="/app" className="button gold">
            Enter the application <ArrowUpRight size={18} />
          </RouteLink>
          <div className="fine-line" />
        </section>
      </main>
    </>
  );
}
export function Footer() {
  const { navigate } = useNav();
  return (
    <footer className="footer">
      <div className="footer-top">
        <RouteLink to="/">
          <Logo />
        </RouteLink>
        <div>
          <p>A private stage for finance.</p>
          <button
            className="replay-opening"
            onClick={() => {
              try {
                localStorage.removeItem("curtain-entered");
              } catch {
                /* Storage may be blocked by the browser. */
              }
              if (location.pathname === "/") {
                window.scrollTo(0, 0);
                dispatchEvent(new Event("curtain:replay"));
              } else navigate("/");
            }}
          >
            Replay the opening <ArrowUpRight size={12} />
          </button>
        </div>
        <Socials />
      </div>
      <div className="footer-bottom">
        <span>© {new Date().getFullYear()} Curtain</span>
        <nav aria-label="Legal navigation">
          <RouteLink to="/legal/privacy">Privacy</RouteLink>
          <RouteLink to="/legal/terms">Terms of use</RouteLink>
          <RouteLink to="/legal/risk">Risk disclosure</RouteLink>
        </nav>
        <span>ROBINHOOD CHAIN · $CRTN</span>
      </div>
    </footer>
  );
}
