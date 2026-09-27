<!-- LOVABLE:BEGIN -->
> [!IMPORTANT]
> This project is connected to [Lovable](https://lovable.dev). Avoid rewriting
> published git history — force pushing, or rebasing/amending/squashing commits
> that are already pushed — as it rewrites history on Lovable's side and the
> user will likely lose their project history.
>
> Commits you push to the connected branch sync back to Lovable and show up in
> the editor, so keep the branch in a working state.
<!-- LOVABLE:END -->

## Project structure

- The Curtain site lives in `src/curtain/` and keeps its own history-based in-page router; route files under `src/routes/` (`/`, `/app`, `/app/$`, `/legal/$type`) mount it through `src/components/CurtainApp.tsx`, so deep links work while the original experience stays intact.
- `CurtainApp` renders client-only (lazy + `ClientOnly`) because the experience uses window, audio, GSAP and wallet APIs at mount.
- Curtain artwork, films and fonts are CDN assets: pointers in `src/assets/curtain/*.asset.json`, referenced by URL from the curtain CSS/TSX, keeping ~30 MB of media out of the repo.
