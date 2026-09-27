# Bring the Curtain site into this project

Your upload is a complete "Curtain" website: a theatrical landing page with velvet curtain
animations, two short films, a private-box dashboard, and three legal pages. The goal is to
get it running here, unchanged in look and behaviour.

## What will happen

- The Curtain landing page becomes the home page of this project.
- The application workspace stays at `/app`, and the legal pages at `/legal/privacy`,
  `/legal/terms`, `/legal/risk`.
- All artwork, the two films, captions and the gold logo come across, plus the self-hosted
  Cormorant Garamond and DM Sans fonts.
- Page titles and social preview text for each page use the Curtain wording from the upload.

## How it gets done

- Copy `src/` screens (App, Dashboard, Legal, StageExperience, VelvetCards, domain,
  useWorkspaceTools) and the four stylesheets plus `fonts.css` into this project.
- Copy `public/assets` and `public/fonts` as-is so every `/assets/...` path keeps working.
- Install the two missing packages the site needs: `gsap` and `lucide-react`.
- Keep the site's own in-page navigation. Add three thin route files
  (`/`, `/app`, `/legal/$type`) that all mount the Curtain app, rendered on the browser side
  only since it relies on window, audio and wallet APIs.
- Give each route its own title/description tags; the favicon points at the gold logo.
- Leave the Ethereum wallet read, fee maths and local-storage plans exactly as delivered —
  no live network services are wired up, matching the handoff notes.

## Notes

- The films and artwork total about 28 MB; they are served as static files.
- Nothing from the upload's `.git`, build scripts or lockfile is brought in.
