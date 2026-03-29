const express = require('express');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const app = express();
const PORT = 3456;

// Read API key from HA options file (injected by supervisor), fall back to env var for local dev
let API_KEY = 'changeme';
try {
	const options = JSON.parse(fs.readFileSync('/data/options.json', 'utf8'));
	API_KEY = options.api_key || API_KEY;
} catch {
	API_KEY = process.env.API_KEY || API_KEY;
}

// Auth middleware
app.use((req, res, next) => {
	if (req.path === '/health') return next();
	const key = req.headers['x-api-key'];
	if (key !== API_KEY) return res.status(401).json({ error: 'Unauthorized' });
	next();
});

/**
 * Runs yt-dlp to fetch captions for a YouTube video.
 * Returns parsed TCaption[] or throws on failure.
 */
async function fetchCaptionsViaYtDlp(videoId) {
	const tmpDir = path.join(os.tmpdir(), `captions-${crypto.randomUUID()}`);
	fs.mkdirSync(tmpDir, { recursive: true });
	const outputTemplate = path.join(tmpDir, 'caps');

	return new Promise((resolve, reject) => {
		const args = [
			'--skip-download',
			'--write-auto-sub',
			'--write-sub',
			'--sub-lang', 'en',
			'--sub-format', 'json3',
			'--write-info-json',
			'-o', outputTemplate,
			'--no-playlist',
			`https://www.youtube.com/watch?v=${videoId}`,
		];

		let stderr = '';
		let authBlocked = false;

		const proc = spawn('yt-dlp', args);
		const timeout = setTimeout(() => {
			proc.kill();
			reject(new Error('yt-dlp timed out after 30s'));
		}, 30_000);

		proc.stderr.on('data', (d) => {
			const msg = d.toString();
			stderr += msg;
			if (msg.includes('Sign in') || msg.includes('bot') || msg.includes('403')) {
				authBlocked = true;
			}
		});

		proc.on('close', (code) => {
			clearTimeout(timeout);

			if (authBlocked) {
				fs.rmSync(tmpDir, { recursive: true, force: true });
				return reject(new Error('YouTube auth/bot block detected'));
			}

			// Find the generated subtitle file
			let subtitleFile = null;
			try {
				const files = fs.readdirSync(tmpDir);
				subtitleFile = files
					.filter((f) => f.endsWith('.json3'))
					.map((f) => path.join(tmpDir, f))[0] ?? null;
			} catch { /* tmpDir might not exist */ }

			if (!subtitleFile) {
				fs.rmSync(tmpDir, { recursive: true, force: true });
				if (code !== 0) return reject(new Error(`yt-dlp exited ${code}: ${stderr.slice(-200)}`));
				return resolve({ captions: [], meta: { title: '', artist: '', thumbnailUrl: '', description: '' } });
			}

			try {
				const raw = JSON.parse(fs.readFileSync(subtitleFile, 'utf8'));
				const captions = parseJson3(raw);

				// Parse metadata from info.json if available
				let metaObj = { title: '', artist: '', thumbnailUrl: '', description: '' };
				const infoFile = fs.readdirSync(tmpDir).find((f) => f.endsWith('.info.json'));
				if (infoFile) {
					const info = JSON.parse(fs.readFileSync(path.join(tmpDir, infoFile), 'utf8'));
					metaObj = {
						title: info.title ?? '',
						artist: info.uploader ?? info.channel ?? '',
						thumbnailUrl: info.thumbnail ?? '',
						description: info.description ?? '',
					};
				}

				fs.rmSync(tmpDir, { recursive: true, force: true });
				resolve({ captions, meta: metaObj });
			} catch (e) {
				fs.rmSync(tmpDir, { recursive: true, force: true });
				reject(new Error(`Failed to parse subtitle file: ${e.message}`));
			}
		});

		proc.on('error', (e) => {
			clearTimeout(timeout);
			fs.rmSync(tmpDir, { recursive: true, force: true });
			reject(new Error(`yt-dlp spawn error: ${e.message}`));
		});
	});
}

/** Converts yt-dlp json3 format into TCaption[] (milliseconds) */
function parseJson3(data) {
	const captions = [];
	for (const event of data.events ?? []) {
		if (!event.segs) continue;
		const text = event.segs.map((s) => s.utf8 ?? '').join('').trim();
		if (!text || text === '\n') continue;
		captions.push({
			text,
			start: event.tStartMs ?? 0,
			durationInMilliseconds: event.dDurationMs ?? 0,
		});
	}
	return captions;
}

/**
 * GET /captions?videoId=xxx
 *
 * Returns:
 *   { captions: TCaption[], title, artist, thumbnailUrl, description }
 */
app.get('/captions', async (req, res) => {
	const { videoId } = req.query;
	if (!videoId || typeof videoId !== 'string') {
		return res.status(400).json({ error: 'videoId query param required' });
	}

	try {
		const { captions, meta } = await fetchCaptionsViaYtDlp(videoId);
		return res.json({ captions, ...meta });
	} catch (e) {
		console.error(`[caption-fetcher] Error for ${videoId}:`, e.message);
		return res.status(500).json({ error: e.message });
	}
});

app.get('/health', (_req, res) => res.json({ ok: true }));

app.listen(PORT, () => console.log(`[caption-fetcher] Listening on :${PORT}`));
