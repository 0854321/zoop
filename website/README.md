# Noop website

Static Astro site using Bun and GitHub Pages. Fonts are bundled locally. English lives at `/noop/`, Simplified Chinese at `/noop/zh-CN/`.

```sh
cd website
bun install --frozen-lockfile
bun run dev
bun run build
bun x playwright install chromium
bun run test
```

The default base is `/noop`. Set `BASE_PATH` and `SITE_URL` together for another host. The production browser tests deliberately verify the GitHub Pages path.

`.github/workflows/website.yml` builds and tests pull requests, then deploys `main` using GitHub Pages. Repository Settings → Pages → Source must be **GitHub Actions**. The site is separate from `web/`, the page each owner's own Worker serves.

`public/install.sh`, `install.ps1`, `install-client.sh` and `install-client.ps1` are symlinks to the repository's installers, so the published installers always match `main`. `public/icon.png` is rendered from `app/icon.png`. `public/screenshot*.png` are screenshots of the app.

The decision card in the hero is an illustration with made-up content, not a browser implementation of Noop. The site follows the system color scheme until an explicit choice is saved.
