# YouTube Caption Fetcher — Home Assistant Add-on

A Home Assistant add-on that fetches YouTube captions via `yt-dlp`, running on your local machine (residential IP). This bypasses YouTube's bot detection that blocks requests from cloud providers like Google Cloud Run.

## How it works

YouTube increasingly blocks caption requests from data-centre IP ranges. This add-on runs `yt-dlp` on your Home Assistant instance (e.g. a Raspberry Pi on a residential internet connection), where YouTube doesn't apply the same restrictions.

The Summaries app on Cloud Run calls this service **first** before falling back to its own cloud-side extraction methods:

```
Cloud Run request
  │
  ▼
1. HA Caption Service (this add-on, residential IP)   ← tried first
2. youtube-caption-extractor + WebShare proxy
3. yt-dlp + YouTube cookie authentication
4. Whisper audio transcription (last resort)
```

## API

All endpoints (except `/health`) require an `x-api-key` header matching the `api_key` set in add-on options.

### `GET /captions?videoId=<id>`

Fetches captions for a YouTube video.

```bash
curl "http://homeassistant.local:3456/captions?videoId=dQw4w9WgXcQ" \
  -H "x-api-key: your_api_key"
```

**Response:**
```json
{
  "captions": [
    { "text": "Hello world", "start": 1000, "durationInMilliseconds": 2500 }
  ],
  "title": "Video Title",
  "artist": "Channel Name",
  "thumbnailUrl": "https://...",
  "description": "..."
}
```

### `GET /health`

Returns `{ "ok": true }`. No auth required.

## Installation

1. In Home Assistant: **Settings → Add-ons → Add-on Store → ⋮ → Repositories**
2. Add: `https://github.com/altr/ha-youtube-caption-fetcher`
3. Install **YouTube Caption Fetcher**
4. Set `api_key` in the add-on **Configuration** tab to a strong random secret
5. Start the add-on

Generate a secure key with:
```bash
openssl rand -hex 32
```

## Exposing the service to Cloud Run

The add-on runs on `localhost:3456` inside your Home Assistant network. To make it reachable from Cloud Run you need to expose it via a reverse proxy.

### Option A — NGINX (recommended if you already use the NGINX SSL proxy add-on)

See the [NGINX configuration section](#nginx-home-assistant-ssl-proxy-configuration) below.

### Option B — Cloudflare Tunnel

Install the [Cloudflare Tunnel community add-on](https://github.com/homeassistant-apps/app-cloudflared), create a tunnel in Cloudflare Zero Trust, and point a public hostname at `http://localhost:3456`.

## Summaries app configuration

Add to your Cloud Run `.env`:

```env
PRIVATE_CAPTION_SERVICE_URL=https://ha.altr.ch/captions
PRIVATE_CAPTION_SERVICE_KEY=your_api_key
```

The app calls `GET ${PRIVATE_CAPTION_SERVICE_URL}/captions?videoId=<id>` with `x-api-key: ${PRIVATE_CAPTION_SERVICE_KEY}`.

---

## NGINX Home Assistant SSL proxy configuration

This documents the exact setup used to expose the caption service at `https://ha.altr.ch/captions/` using the existing [NGINX Home Assistant SSL proxy](https://github.com/home-assistant/addons/tree/master/nginx_proxy) add-on, without adding a new subdomain or SSL certificate.

### Add-on options (`config.yaml`)

```yaml
domain: ha.altr.ch
hsts: max-age=31536000; includeSubDomains
certfile: fullchain.pem
keyfile: privkey.pem
cloudflare: false
use_ssl_backend: false
customize:
  active: true
  default: nginx_proxy_default*.conf
  servers: nginx_proxy/*.conf
real_ip_from: []
```

The key change from the default is `customize.active: true`, which tells the add-on to load any `.conf` files from the paths specified in `default` and `servers`.

### Custom location file

Create `/config/nginx_proxy_default_captions.conf` via the HA **File editor** add-on or SSH:

```nginx
location /captions/ {
    proxy_pass http://localhost:3456/;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
}
```

The trailing slash on `proxy_pass` strips the `/captions/` prefix before forwarding to the add-on, so the add-on receives requests at `/captions?videoId=...` as `/captions?videoId=...`.

Restart the NGINX add-on after creating the file. Any nginx config errors will appear in the add-on **Log** tab.

### DNS

`ha.altr.ch` is a CNAME pointing to the root `altr.ch` A record, managed on FreeDNS (afraid.org). No additional DNS record is needed since the caption service is served as a path under the existing domain.

### Testing

```bash
# Test the add-on directly (from your local network)
curl http://homeassistant.local:3456/health

# Test with auth
curl "http://homeassistant.local:3456/captions?videoId=dQw4w9WgXcQ" \
  -H "x-api-key: your_api_key"

# Test through NGINX (from anywhere)
curl https://ha.altr.ch/captions/health

# Test caption fetch through NGINX
curl "https://ha.altr.ch/captions/captions?videoId=dQw4w9WgXcQ" \
  -H "x-api-key: your_api_key"
```
