import { ArrowUpRight, Info } from "lucide-react";
import { RouteLink } from "./App";
const titles: Record<string, string> = {
  privacy: "Privacy notice",
  terms: "Terms of use",
  risk: "Risk disclosure",
};
export default function Legal({ type }: { type: string }) {
  const page = titles[type] ? type : "terms";
  return (
    <main id="main" className="section legal">
      <div className="legal-header">
        <p className="eyebrow">CURTAIN / THE FINE PRINT</p>
        <h1 tabIndex={-1}>{titles[page]}</h1>
        <p>
          Clarity is part of the architecture. Understand the interface, your choices, and the
          limits of the technology.
        </p>
      </div>
      <div className="legal-layout">
        <nav className="legal-nav" aria-label="Legal pages">
          {Object.entries(titles).map(([key, title]) => (
            <RouteLink key={key} className={page === key ? "active" : ""} to={"/legal/" + key}>
              {title}
            </RouteLink>
          ))}
          <RouteLink to="/app">
            Your private box <ArrowUpRight size={12} />
          </RouteLink>
        </nav>
        <article className="legal-copy">
          <p className="legal-date">LAST UPDATED · 1 OCTOBER 2026</p>
          {page === "privacy" ? (
            <>
              <section>
                <h2>01. What this interface stores</h2>
                <p>
                  Curtain stores escape tickets and interface preferences in your browser’s local
                  storage. Tickets include the vault, deposit identifier, private deadline and salt.
                  Saved activity also includes amounts, tokens, recipients and transaction
                  references, grouped by wallet. These records stay on this device unless you
                  download them.
                </p>
                <p>
                  This interface does not request or store a recovery phrase, wallet private key. Do
                  not enter those secrets in any field.
                </p>
              </section>
              <section>
                <h2>02. Wallet connections</h2>
                <p>
                  Connecting a browser wallet asks the wallet provider for the public account you
                  approve. The connected address is held in memory and is used to group saved escape
                  tickets and retrieve balances and staking positions. Disconnecting or changing
                  accounts in the wallet updates the interface. Connection itself does not authorize
                  transfers.
                </p>
                <p>
                  Your wallet provider operates separately and may process connection requests under
                  its own terms and privacy policy.
                </p>
              </section>
              <section>
                <h2>03. Requests, media & hosting</h2>
                <p>
                  Fonts, artwork, and films are served with this website. The interface includes no
                  advertising tracker or analytics integration. The hosting provider may process
                  ordinary request information, such as IP address and browser information, to
                  deliver and secure the website. Its own privacy terms govern that processing.
                </p>
                <p>
                  Configured network RPC services receive balance, position and transaction
                  requests. The operator receives swap tokens, amount, recipient, depositor, minimum
                  output and delay window. Escape tickets are never uploaded by this interface;
                  refund transactions disclose their required data on-chain.
                </p>
              </section>
              <section>
                <h2>04. Your choices</h2>
                <p>
                  You can download and import escape tickets from Activity. Keep a backup before
                  clearing browser data, which removes saved tickets and preferences. Downloaded
                  files remain wherever you save them.
                </p>
                <p>
                  People with access to your browser profile may be able to read saved tickets.
                  Local storage is not encrypted. Use your device’s access controls and keep your
                  ticket files private.
                </p>
              </section>
              <section>
                <h2>05. Disclosure & public networks</h2>
                <p>
                  A ticket reveals the private deadline for your swap. Share transaction information
                  selectively; recipients can retain anything you send them.
                </p>
                <p>
                  Blockchain records can be public and persistent. A privacy protocol does not
                  remove all observable information, including timing, fees, public deposits, or
                  exits. Consider what a recipient or network participant can infer.
                </p>
              </section>
            </>
          ) : page === "risk" ? (
            <>
              <section>
                <h2>01. Assets can lose value</h2>
                <p>
                  Digital assets can be volatile or illiquid. Stablecoin value and redemption depend
                  on the issuer, reserves, counterparties, and market conditions. A Stock Token may
                  not provide the same rights as directly holding a company’s shares. Review the
                  issuer’s current terms and eligibility rules for each asset.
                </p>
                <p>
                  Neither this interface nor its illustrations represent a promise of performance,
                  insured deposits, or verified asset backing. The{" "}
                  <a
                    href="https://www.investor.gov/introduction-investing/general-resources/news-alerts/alerts-bulletins/investor-alerts/crypto-asset-securities"
                    target="_blank"
                    rel="noreferrer"
                  >
                    SEC’s investor alert on crypto asset risks
                  </a>{" "}
                  provides general background on volatility, loss, and platform risks.
                </p>
              </section>
              <section>
                <h2>02. Software & protocol risk</h2>
                <p>
                  Smart contracts, wallets, and integrations can contain defects. An exploit or
                  incorrect configuration can cause permanent loss. Descriptions of intended
                  behavior do not establish that deployed code has been audited or that it behaves
                  correctly.
                </p>
                <p>
                  Confirm the network, contract addresses, asset registry, fees, and relevant audit
                  material independently before authorizing any transaction. Never send assets to an
                  unverified address.
                </p>
              </section>
              <section>
                <h2>03. Settlement & availability</h2>
                <p>
                  Operators, keepers and network infrastructure can be unavailable or delayed. A
                  quote estimates current output; it does not guarantee delivery time or settlement
                  price.
                </p>
                <p>
                  If a swap misses its deadline, the depositing wallet can request a refund three
                  minutes later using its escape ticket. Finalization follows a ten-minute challenge
                  window. This depends on possession of the ticket and wallet, RPC access and actual
                  deployed contract behavior.
                </p>
              </section>
              <section>
                <h2>04. DeFi & execution</h2>
                <p>
                  Swaps face slippage, price changes, liquidity limits, and transaction ordering
                  risk. Vault positions face the underlying protocol’s contract, collateral,
                  liquidity, and valuation risks. A vault’s value can decrease.
                </p>
                <p>
                  A swap below your minimum output waits for a better price. If its deadline passes,
                  use the refund flow. Staking locks your deposit until the selected unlock time;
                  rewards depend on the configured reward programme. Lending is coming soon.
                </p>
              </section>
              <section>
                <h2>05. Privacy & keys</h2>
                <p>
                  Privacy depends on implementation, usage, and the information you share. Public
                  transactions and external observations can reveal patterns. Disclosure recipients
                  can retain information. Losing your wallet keys or escape ticket can prevent
                  access to assets; the interface cannot restore a recovery phrase.
                </p>
              </section>
              <section>
                <h2>06. Regulatory & personal responsibility</h2>
                <p>
                  Availability and permitted uses vary by location and asset. You are responsible
                  for understanding applicable restrictions and your own reporting obligations.
                  Website access does not establish your eligibility for a token or service. Obtain
                  qualified advice when needed.
                </p>
              </section>
            </>
          ) : (
            <>
              <section>
                <h2>01. Scope of the interface</h2>
                <p>
                  Curtain provides a workspace for private swaps, staking and saved activity. When
                  configured, the interface reads live balances and submits transactions through
                  your wallet. Lending is coming soon.
                </p>
                <p>
                  Protocol descriptions communicate the supplied design specification. They are not
                  evidence of deployment, an audit, regulatory approval, or operational
                  availability.
                </p>
              </section>
              <section>
                <h2>02. Your wallet & authorization</h2>
                <p>
                  You control the wallet you connect. Review every wallet request and verify the
                  destination, network, amount, and permissions before approving. Connecting your
                  wallet alone does not authorize transfers.
                </p>
                <p>
                  You are responsible for preserving the keys and recovery material required by your
                  wallet. Keep a backup of every escape ticket.
                </p>
              </section>
              <section>
                <h2>03. Fees & estimates</h2>
                <p>
                  Private swaps charge a 0.20% protocol fee and a 0.05% keeper fee. Live quotes show
                  expected output after fees and a suggested minimum. Network costs are separate;
                  quotes are estimates.
                </p>
                <p>
                  Stock-token balances are displayed in raw token units using their on-chain
                  decimals. Stock splits and dividends can affect adjusted values.
                </p>
              </section>
              <section>
                <h2>04. Permitted use</h2>
                <p>
                  Use the interface only where you are eligible and for lawful purposes. Do not
                  attempt to interfere with the website, obtain another person’s keys, introduce
                  malicious code, or misrepresent an incomplete swap as a delivered transaction.
                </p>
                <p>
                  Privacy features do not exempt anyone from applicable obligations or create
                  permission to evade asset restrictions.
                </p>
              </section>
              <section>
                <h2>05. External systems</h2>
                <p>
                  Wallets, token issuers, networks, and DeFi protocols are independent systems with
                  their own terms and risks. Mentioning a protocol or asset identifies a proposed
                  integration; it does not imply endorsement or an active commercial partnership.
                </p>
                <p>
                  Telegram, X, and GitHub controls currently display a coming-soon notice. They do
                  not redirect to unofficial accounts.
                </p>
              </section>
              <section>
                <h2>06. Information & availability</h2>
                <p>
                  Content is provided for general product information. It is not personalized
                  investment, tax, or legal advice. Availability, estimates, and technical
                  descriptions may change or contain errors. Do not rely on the interface as your
                  sole source for an investment decision.
                </p>
                <p>
                  Review the <RouteLink to="/legal/risk">risk disclosure</RouteLink> and{" "}
                  <RouteLink to="/legal/privacy">privacy notice</RouteLink>. Nothing on this page
                  excludes rights that cannot lawfully be excluded.
                </p>
              </section>
            </>
          )}
          <RouteLink to="/" className="underlined-link">
            Return to the theatre <ArrowUpRight size={15} />
          </RouteLink>
        </article>
      </div>
    </main>
  );
}
