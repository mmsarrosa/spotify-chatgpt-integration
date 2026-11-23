
const express = require("express");
const crypto = require("crypto");
require("dotenv").config();

const app = express();
app.use(express.json());

const {
  SPOTIFY_CLIENT_ID,
  SPOTIFY_CLIENT_SECRET,
  SPOTIFY_REDIRECT_URI,
  API_KEY
} = process.env;

const PORT = process.env.PORT || 3000;
const SCOPES = [
  "user-read-private",
  "user-read-email",
  "user-read-playback-state",
  "user-modify-playback-state",
  "user-read-currently-playing",
  "playlist-read-private",
  "playlist-read-collaborative",
  "playlist-modify-private",
  "playlist-modify-public",
  "user-library-read",
  "user-library-modify",
  "user-top-read",
  "user-read-recently-played"
].join(" ");

let tokens = null;
const pendingStates = new Map();

app.get("/", (req, res) => {
  res.send("Spotify ChatGPT Integration is running.");
});

app.get("/health", (req, res) => {
  res.json({ status: "ok" });
});

// Start Spotify authorization
app.get("/login", (req, res) => {
  const state = crypto.randomBytes(24).toString("hex");

  pendingStates.set(state, Date.now());

  const params = new URLSearchParams({
    client_id: SPOTIFY_CLIENT_ID,
    response_type: "code",
    redirect_uri: SPOTIFY_REDIRECT_URI,
    scope: SCOPES,
    state: state
  });

  res.redirect(
    "https://accounts.spotify.com/authorize?" +
    params.toString()
  );
});

// Spotify authorization callback
app.get("/callback", async (req, res) => {
  try {
    const { code, state, error } = req.query;

    const created = pendingStates.get(state);
    pendingStates.delete(state);

    if (error) {
      return res.status(400).send("Spotify authorization denied.");
    }

    if (!created || Date.now() - created > 600000) {
      return res.status(400).send("Invalid or expired authorization state.");
    }

    const credentials = Buffer.from(
      `${SPOTIFY_CLIENT_ID}:${SPOTIFY_CLIENT_SECRET}`
    ).toString("base64");

    const response = await fetch(
      "https://accounts.spotify.com/api/token",
      {
        method: "POST",
        headers: {
          Authorization: `Basic ${credentials}`,
          "Content-Type": "application/x-www-form-urlencoded"
        },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code,
          redirect_uri: SPOTIFY_REDIRECT_URI
        })
      }
    );

    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error_description || "Token exchange failed");
    }

    tokens = {
      access_token: data.access_token,
      refresh_token: data.refresh_token,
      expires_at: Date.now() + data.expires_in * 1000
    };

    res.send("Spotify successfully connected! You can close this page.");
  } catch (err) {
    console.error(err.message);
    res.status(500).send("Spotify connection failed.");
  }
});

// Refresh Spotify access token when necessary
async function getAccessToken() {
  if (!tokens) {
    throw new Error("Spotify is not connected. Visit /login first.");
  }

  if (Date.now() < tokens.expires_at - 60000) {
    return tokens.access_token;
  }

  const credentials = Buffer.from(
    `${SPOTIFY_CLIENT_ID}:${SPOTIFY_CLIENT_SECRET}`
  ).toString("base64");

  const response = await fetch(
    "https://accounts.spotify.com/api/token",
    {
      method: "POST",
      headers: {
        Authorization: `Basic ${credentials}`,
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: tokens.refresh_token
      })
    }
  );

  const data = await response.json();

  if (!response.ok) {
    throw new Error("Spotify token refresh failed.");
  }

  tokens.access_token = data.access_token;
  tokens.expires_at = Date.now() + data.expires_in * 1000;

  if (data.refresh_token) {
    tokens.refresh_token = data.refresh_token;
  }

  return tokens.access_token;
}

// Secure all Spotify API routes
app.use("/api", (req, res, next) => {
  if (!API_KEY || req.headers["x-api-key"] !== API_KEY) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
});

// Spotify API helper
async function spotifyRequest(path, method = "GET", body = null) {
  const accessToken = await getAccessToken();

  const response = await fetch(
    `https://api.spotify.com/v1${path}`,
    {
      method,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json"
      },
      ...(body ? { body: JSON.stringify(body) } : {})
    }
  );

  const data = response.status === 204
    ? null
    : await response.json();

  if (!response.ok) {
    throw new Error(
      data?.error?.message || `Spotify API error: ${response.status}`
    );
  }

  return data;
}

function route(handler) {
  return async (req, res) => {
    try {
      const result = await handler(req, res);
      if (!res.headersSent) {
        res.json(result ?? { success: true });
      }
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  };
}

// Account
app.get("/api/me", route(() =>
  spotifyRequest("/me")
));

// Search tracks, artists, albums and shows
app.get("/api/search", route(req => {
  const q = req.query.q;
  const type = req.query.type || "track,artist,album,show";

  if (!q) throw new Error("Search query is required.");

  const params = new URLSearchParams({
    q,
    type,
    limit: String(Math.min(Number(req.query.limit) || 20, 50))
  });

  return spotifyRequest(`/search?${params}`);
}));

// User playlists
app.get("/api/playlists", route(() =>
  spotifyRequest("/me/playlists?limit=50")
));

// Saved tracks
app.get("/api/library/tracks", route(() =>
  spotifyRequest("/me/tracks?limit=50")
));

// Top artists
app.get("/api/top-artists", route(() =>
  spotifyRequest("/me/top/artists?limit=20")
));

// Recently played
app.get("/api/recent", route(() =>
  spotifyRequest("/me/player/recently-played?limit=20")
));

// Create a private or public playlist
app.post("/api/playlists", route(req => {
  if (!req.body.name) throw new Error("Playlist name is required.");

  return spotifyRequest("/me/playlists", "POST", {
    name: req.body.name,
    description: req.body.description || "",
    public: req.body.public === true
  });
}));

// Add tracks to an existing playlist
app.post("/api/playlists/:id/tracks", route(req => {
  if (!Array.isArray(req.body.uris)) {
    throw new Error("Provide an array of Spotify track URIs.");
  }

  return spotifyRequest(
    `/playlists/${encodeURIComponent(req.params.id)}/tracks`,
    "POST",
    { uris: req.body.uris }
  );
}));

// Current playback
app.get("/api/player", route(() =>
  spotifyRequest("/me/player")
));

// Start or resume playback
app.post("/api/player/play", route(req => {
  const device = req.query.device_id
    ? `?device_id=${encodeURIComponent(req.query.device_id)}`
    : "";

  return spotifyRequest(
    `/me/player/play${device}`,
    "PUT",
    req.body
  );
}));

// Pause playback
app.put("/api/player/pause", route(() =>
  spotifyRequest("/me/player/pause", "PUT")
));

// Skip to next track
app.post("/api/player/next", route(() =>
  spotifyRequest("/me/player/next", "POST")
));

// Skip to previous track
app.post("/api/player/previous", route(() =>
  spotifyRequest("/me/player/previous", "POST")
));

// Available Spotify devices
app.get("/api/devices", route(() =>
  spotifyRequest("/me/player/devices")
));

app.listen(PORT, () => {
  console.log(`Spotify integration running on port ${PORT}`);
});
