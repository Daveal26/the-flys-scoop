## The Flys Scoop

“News / Media / Movies / TV / Gossip” scoop finder with:
- **Signup + Login**
- **Member uploads** (link + optional video/image)
- **AI Scoop Finder** (RSS-based web searching + auto-categorization)
- **1 minute clip generator** (best-effort via `ffmpeg`)
- **Learning loop** (upvote/downvote trains category keywords over time)

Every scoop displays the message:
- **The Flys Scoop new scoop**

### Run it (Windows)

From `C:\The-Fly-On-The-Wall`:

```powershell
npm install
npm run start
```

Then open:
- `http://localhost:5173`

### Deploy with your Vercel domain (recommended setup)

Vercel is great for the **website + domain**, but this project’s backend does:
- file uploads
- ffmpeg video editing
- Whisper subtitles
- SQLite writes

Those are **not a good fit for Vercel Serverless**.

Recommended production setup:
- **Vercel**: hosts the site + your domain (e.g. `theflysScoop.com`)
- **Backend host** (Render/Fly.io/DigitalOcean/etc): runs `server.js` with ffmpeg + Python installed
- Vercel **rewrites** `/api/*` and `/uploads/*` to your backend so the frontend still works with same-origin `/api` calls.

#### Vercel rewrite config

Edit `vercel.json` and replace:
- `https://YOUR_BACKEND_HOST`

with your real backend URL, for example:
- `https://theflys-scoop-api.onrender.com`

#### Vercel project settings

Set **Output Directory** to:
- `public`

### Deploy backend on Fly.io (works with uploads + ffmpeg + Whisper)

This backend needs a server (not Vercel serverless). Fly.io works well.

#### 1) Install Fly CLI

Install `flyctl` from Fly.io docs, then login:

```powershell
fly auth login
```

#### 2) Launch the backend app

From this repo:

```powershell
cd "C:\The-Fly-On-The-Wall"
fly launch
```

When asked, use this as the deploy type:
- **Dockerfile**

#### 3) Create a volume (required)

This persists:
- SQLite DB (`/data/app.sqlite`)
- uploads (`/data/uploads`)

Example (match your region):

```powershell
fly volumes create appdata --size 10 --region iad
```

#### 4) Set Fly secrets (required)

```powershell
fly secrets set JWT_SECRET="change-me" APP_ORIGINS="https://theflysScoop.com" ADMIN_TOKEN="change-me" CASHAPP_LINK="https://cash.app/$teon27"
```

#### 5) Deploy

```powershell
fly deploy
```

Fly will give you a backend URL like:
- `https://<your-app>.fly.dev`

#### 6) Point Vercel to the backend

Edit `vercel.json` and set your Fly backend URL (example):
- `https://the-flys-scoop.fly.dev`

### Optional: enable video clipping (1 minute edits)

Install `ffmpeg` and make sure `ffmpeg` is on your PATH, or set:
- `FFMPEG_PATH=C:\path\to\ffmpeg.exe`

If `ffmpeg` isn’t available, scoops still post; video clipping just gets skipped.

### Videos: focus on member uploads

This app focuses on **member-uploaded videos**:
- Members upload a video file with a scoop
- The server auto-creates a **1 minute clip** (best-effort via `ffmpeg`)
- Members can choose **Auto edit** (smart) or **Manual edit** (start/duration)
- Optional: **Generate real subtitles (Whisper, local)** and burn them into the clip

### Configure environment

Copy `env.example` to `.env` (or set environment vars in your shell):
- `PORT`
- `APP_ORIGINS`
- `JWT_SECRET`
- `AI_AUTO_RUN_INTERVAL_MINUTES`

### Manual verification (CashApp/Venmo)

This app supports **manual paid verification**:
- Put your payment links in `.env`:
  - `CASHAPP_LINK`
  - `VENMO_LINK`
- Users go to **Profile → Get Verified**, pay you, then upload a receipt screenshot and submit a request.
- You (admin) review pending requests and approve/deny them.

Admin endpoints (send header `x-admin-token: <ADMIN_TOKEN>`):
- `GET /api/admin/verification/requests` (pending list)
- `POST /api/admin/verification/:id/approve`
- `POST /api/admin/verification/:id/deny`


### Optional: Whisper subtitles (local)

When a member checks **Generate real subtitles**, the server will:
- create the clip
- transcribe it locally using **Whisper** (via Python `faster-whisper`)
- burn subtitles into the final clip

Defaults:
- `WHISPER_MODEL=small`
- `WHISPER_LANGUAGE=en`

Auto-install behavior:
- By default, the server will attempt `pip install faster-whisper` the first time subtitles are requested.
- To disable auto-install, set: `WHISPER_AUTO_INSTALL=0`
- To disable subtitles entirely, set: `WHISPER_ENABLED=0`

### Optional: Face detection signal (auto edit)

Auto edit can use a **face presence** signal (to prefer segments where faces appear).

Auto-install behavior:
- By default, the server will attempt `pip install opencv-python` the first time face detection is used.
- To disable auto-install, set: `FACE_AUTO_INSTALL=0`
- To disable face detection entirely, set: `FACE_ENABLED=0`

### Where data is stored

- SQLite DB: `data/app.sqlite`
- Uploads: `uploads/`

### AI sources (RSS)

Edit:
- `src/ai/rssSources.js`

Add/remove RSS feeds to control where the AI pulls scoops from.


