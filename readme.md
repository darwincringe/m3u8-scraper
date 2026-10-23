# Video Stream Extractor API

Node/Express API for `api.srctv.space`: resolves HLS streams (vaplayer, flixhq, catflix, ophim) and subtitles for movies/TV by TMDB id.

---

## Ops: vidnest secret rotation

flixhq / catflix / ophim go through `new.vidnest.fun`. Their API answers in an encrypted v2 envelope. When they rotate the AES secret, those three sources die with decrypt / “secret rotated?” errors and **only vaplayer stays up**.

### Manual fix

```bash
# Check whether the secret changed (safe, no writes)
npm run vidnest-secret
# or: node scripts/update-vidnest-secret.mjs

# Prod-friendly: write VIDNEST_SECRET into .env (does not dirty git)
node scripts/update-vidnest-secret.mjs --env-apply
pm2 restart backend --update-env

# Optional: also patch the default in utils/catflix.js for the repo
npm run vidnest-secret:apply
# then commit / push / pull on the droplet
```

### Cron on prod (every 3 days)

Runs on the droplet, updates `.env` only when the bundle secret differs, then restarts PM2.

```cron
# /etc/cron.d/vidnest-secret  (or root crontab)
0 4 */3 * * root /var/www/m3u8-scraper/scripts/cron-vidnest-secret.sh
```

Log: `/var/log/vidnest-secret.log`

The cron job loads `.env` (so `CATFLIX_RELAY` / `CATFLIX_RELAY_KEY` are set) and fetches vidnest’s JS **through the Worker relay** — the droplet’s IP is WAF-blocked on `vidnest.fun` just like on the API.

### Symptoms that mean “run this”

- `/extract` mirrors show only `vaplayer`
- Logs: `vidnest v2 decrypt failed … secret rotated?`

---

## Features

- `/extract` with multi-source mirrors (`vaplayer`, `flixhq`, `catflix`, `ophim`) and optional `?source=`
- HLS proxy with fMP4 / TS handling
- Vidnest relay (Cloudflare Worker) for datacenter WAF bypass
- Account sync (library, progress, subtitle prefs)

---

## Getting Started

### Prerequisites

- [Node.js](https://nodejs.org/) v16 or higher installed.
- [Docker](https://www.docker.com/) installed (optional, recommended for deployment).
- Git (for version control).

---

### Installation

1. Clone the repository:

   ```bash
   git clone https://github.com/yourusername/your-repo.git
   cd your-repo

   ```

2. Install dependencies:
   npm install

3. Run the server locally:
   npm start

By default, the server listens on port 3000. To use a different port, set the environment variable: PORT=4000

---

## API Usage

Endpoint: /extract
Method: GET

Extract video stream URLs and subtitles.

## Query Parameters:

### Parameter Type Required Description

tmdb_id string Yes TMDB movie or TV show ID
type string No "movie" (default) or "tv"
season integer Required if type=tv TV show season number
episode integer Required if type=tv TV show episode number

---

## Examples

Movie

```bash
GET /extract?tmdb_id=550&type=movie
```

TV Show

```bash
GET /extract?tmdb_id=1399&type=tv&season=1&episode=1
```

Response Format:

```bash
{
"success": true,
"results": {
    "https://vidsrc.xyz": {
        "hls_url": "https://example.m3u8",
        "subtitles": [
        "https://example.vtt"
        ],
        "error": null
    },
    "https://vidsrc.in": {
        "hls_url": "https://example.m3u8",
        "subtitles": [
        "https://example.vtt"
        ],
        "error": null
    },
    "https://vidsrc.pm": {
        "hls_url": "https://example.m3u8",
        "subtitles": [
        "https://example.vtt"
        ],
        "error": null
    },
    "https://vidsrc.net": {
        "hls_url": "https://example.m3u8",
        "subtitles": [
        "https://example.vtt"
        ],
        "error": null
    }
}
}
```
