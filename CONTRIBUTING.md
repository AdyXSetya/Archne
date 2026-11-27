# Contributing to Archne

Thanks for your interest! Bug reports, ideas, and pull requests are all welcome.

## Before you start

- **Bugs:** open an issue with the Bug report template. Run `debug.bat` and attach the relevant part of `logs/` if you can.
- **Features or big changes:** open an issue first so we can agree on direction before you spend time on it.
- **Security problems:** do not open an issue. See [SECURITY.md](SECURITY.md).

## Setup

```bash
git clone https://github.com/AdyXSetya/archne.git
cd archne
npm install
npm start          # desktop app (Electron)
npm run serve      # browser mode, no Electron needed
```

Node.js 22.12 or newer is required. Node 24 is recommended.

## Code guidelines

- **Two languages.** Every new UI text goes into both `renderer/i18n/archne-en.js` and `renderer/i18n/archne-id.js`, with the same key.
- **Script order.** UI files in `renderer/js/` are plain global scripts loaded in the order of the `<script>` tags in `renderer/archne-index.html`. Put the tag of a new file in the right place.
- **File size.** Keep files in `src/core`, `renderer/js`, and `renderer/css` small (under about 30 KB or 450 lines). Split a file instead of letting it grow.
- **No secrets.** Never commit keystores (`*.jks`), `release.pass`, or data folders.

## Pull requests

1. Fork, then create a branch from `main`.
2. Keep the change focused; unrelated cleanups go in a separate PR.
3. Describe how you tried it on Windows, Android, or browser mode.
4. Add a line to `CHANGELOG.md` (and `CHANGELOG.id.md`) when the change is visible to users.

By contributing you agree that your work is released under the [MIT License](LICENSE).
