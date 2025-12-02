const express = require("express");
const cors = require("cors");
require("dotenv").config();

const app = express();
app.use(cors());
app.use(express.json());
app.set("json spaces", 2);

// Config
const PORT = process.env.PORT || 3000;
const COOKIE = process.env.ROBLOX_COOKIE;

const API = {
  servers: "https://games.roblox.com/v1/games",
  presence: "https://presence.roblox.com/v1/presence/users",
  auth: "https://users.roblox.com/v1/users/authenticated",
  csrf: "https://auth.roblox.com/v2/logout",
};

// === Helpers ===
// Build a Roblox join link for a given placeId and gameId
const buildJoinLink = (placeId, gameId) =>
  `roblox://experiences/start?placeId=${placeId}&gameInstanceId=${gameId}`;

// Fetch CSRF token using the provided cookie
async function getCsrfToken() {
  const res = await fetch(API.csrf, {
    method: "POST",
    headers: { Cookie: COOKIE },
  });
  return res.headers.get("x-csrf-token");
}

// Fetch servers for a given placeId with optional sorting and pagination
async function fetchServers(placeId, { sortOrder = "Desc", cursor = null } = {}) {
  const params = new URLSearchParams({
    sortOrder,
    excludeFullGames: "true",
    limit: "100",
  });
  if (cursor) params.set("cursor", cursor);

  const res = await fetch(`${API.servers}/${placeId}/servers/0?${params}`, {
    headers: { Cookie: COOKIE },
  });
  return res.json();
}

// Fetch presence information for a list of userIds
async function getPresences(userIds, csrfToken) {
  const res = await fetch(API.presence, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Cookie: COOKIE,
      "x-csrf-token": csrfToken,
    },
    body: JSON.stringify({ userIds }),
  });
  return res.json();
}

// Fetch server region
async function getServerRegion(placeId, serverId) {
  try {
    const csrfToken = await getCsrfToken();

    const joinRes = await fetch("https://gamejoin.roblox.com/v1/join-game-instance", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: COOKIE,
        "x-csrf-token": csrfToken,
        "Referer": `https://www.roblox.com/games/${placeId}`,
        "Origin": "https://roblox.com",
        "User-Agent": "Roblox/WinInet"
      },
      body: JSON.stringify({
        placeId: parseInt(placeId),
        isTeleport: false,
        gameId: serverId,
        gameJoinAttemptId: serverId
      }),
    });

    let joinData = await joinRes.json();

    console.log("Init join response:", JSON.stringify(joinData, null, 2));

    if (joinData.status === 22 && joinData.jobId) {
      const maxRetries = 10;
      for (let i = 0; i < maxRetries; i++) {
        await new Promise(resolve => setTimeout(resolve, 1000));

        const pollRes = await fetch(`https://gamejoin.roblox.com/v1/join-game-instance`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Cookie: COOKIE,
            "x-csrf-token": csrfToken,
            "Referer": `https://www.roblox.com/games/${placeId}`,
            "Origin": "https://roblox.com",
            "User-Agent": "Roblox/WinInet"
          },
          body: JSON.stringify({
            placeId: parseInt(placeId),
            isTeleport: false,
            gameId: serverId,
            gameJoinAttemptId: serverId
          }),
        });

        joinData = await pollRes.json();
        console.log(`Poll join response (attempt ${i + 1}):, status ${joinData.status}`);

        if (joinData.status !== 22) break;
      }
    }

    if (!joinData.joinScript?.UdmuxEndpoints?.[0]?.Address) {
      console.log("No IP found in join response, status:", joinData.status, "Message:", joinData.message);
      return null;
    }

    const ip = joinData.joinScript.UdmuxEndpoints[0].Address;
    console.log("Server IP:", ip);

    const geoRes = await fetch(`http://ip-api.com/json/${ip}`);
    const geo = await geoRes.json();

    console.log("Geo data:", geo);

    return {
      ip,
      country: geo.country,
      countryCode: geo.countryCode,
      region: geo.regionName,
      city: geo.city,
      lat: geo.lat,
      lon: geo.lon
    };
  } catch (error) {
    console.error("Error fetching server region:", error);
    return { error: error.message };
  }
}

// Format server data into a readable text format
function formatServers(servers, placeId) {
  let text = `Total Servers: ${servers.length}\n\n`;

  servers.forEach((server, i) => {
    text += `Server ${i + 1}:\n`;
    text += `  ID: ${server.id}\n`;
    text += `  Players: ${server.playing}/${server.maxPlayers}\n`;
    text += `  FPS: ${server.fps.toFixed(2)}\n`;
    text += `  Ping: ${server.ping}ms\n`;
    text += `  Player Tokens: ${server.playerTokens?.length || 0}\n`;
    text += `  Join Link: ${buildJoinLink(placeId, server.id)}\n\n`;
  });

  return text;
}

// Send response in either JSON or formatted text
function sendResponse(res, data, parsed, placeId) {
  if (parsed) {
    res.set("Content-Type", "text/plain");
    res.send(formatServers(data.servers, placeId));
  } else {
    res.json(data);
  }
}

// === Routes ===
// Test authentication by fetching authenticated user info
app.get("/api/test-auth", async (req, res) => {
  try {
    const response = await fetch(API.auth, { headers: { Cookie: COOKIE } });
    res.json(await response.json());
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Fetch servers for a given placeId with optional limit and parsed format
app.get("/api/servers/:placeId", async (req, res) => {
  const { placeId } = req.params;
  const limit = req.query.limit ? parseInt(req.query.limit) : null;
  const parsed = req.query.parsed === "true";

  if (!/^\d+$/.test(placeId)) {
    return res.status(400).json({ error: "Invalid placeId" });
  }

  try {
    let servers = [];
    let cursor = null;

    while (true) {
      const data = await fetchServers(placeId, { cursor });

      if (data.data) servers.push(...data.data);

      if (limit && servers.length >= limit) {
        servers = servers.slice(0, limit);
        break;
      }

      if (!data.nextPageCursor) break;
      cursor = data.nextPageCursor;
    }

    sendResponse(res, { servers, totalServers: servers.length }, parsed, placeId);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Fetch servers where friends are present for a given placeId
app.post("/api/servers/filtered/:placeId", async (req, res) => {
  const { placeId } = req.params;
  const { friendIds, parsed } = req.body;

  if (!friendIds?.length) {
    return res.status(400).json({ error: "friendIds required" });
  }

  try {
    const csrfToken = await getCsrfToken();
    const presenceData = await getPresences(friendIds, csrfToken);

    const friendGameIds = new Set(
      presenceData.userPresences
        .filter((p) => p.placeId?.toString() === placeId && p.gameId)
        .map((p) => p.gameId)
    );

    const matchingServers = [];
    const seenServers = new Set();
    let totalSearched = 0;
    let pages = 0;

    for (const sortOrder of ["Desc", "Asc"]) {
      let cursor = null;
      let sortPages = 0;

      while (sortPages < 20) {
        const data = await fetchServers(placeId, { sortOrder, cursor });

        for (const server of data.data || []) {
          if (seenServers.has(server.id)) continue;
          seenServers.add(server.id);
          totalSearched++;

          if (friendGameIds.has(server.id)) {
            matchingServers.push(server);
          }
        }

        pages++;
        sortPages++;

        if (matchingServers.length >= friendGameIds.size) break;
        if (!data.nextPageCursor) break;
        cursor = data.nextPageCursor;
      }

      if (matchingServers.length >= friendGameIds.size) break;
    }

    if (parsed) {
      let text = formatServers(matchingServers, placeId);
      text += `\nFriend Presences:\n`;

      presenceData.userPresences.forEach((p) => {
        text += `  User ${p.userId}: ${p.lastLocation || "Unknown"}\n`;
        if (p.gameId) {
          text += `    Join: ${buildJoinLink(p.placeId, p.gameId)}\n`;
        }
      });

      text += `\nSearched ${totalSearched} servers across ${pages} pages\n`;
      res.set("Content-Type", "text/plain").send(text);
    } else {
      res.json({
        servers: matchingServers,
        presences: presenceData.userPresences,
        joinLinks: presenceData.userPresences
          .filter((p) => p.gameId && p.placeId?.toString() === placeId)
          .map((p) => ({
            userId: p.userId,
            joinUrl: buildJoinLink(p.placeId, p.gameId),
          })),
        debug: { totalSearched, uniqueServers: seenServers.size, pages },
      });
    }
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Region endpoint
app.get("/api/servers/:placeId/region", async (req, res) => {
  const { placeId } = req.params;
  const limit = req.query.limit ? parseInt(req.query.limit) : 10;
  const filterRegion = req.query.region;
  const skip = req.query.skip ? parseInt(req.query.skip) : 70;

  try {
    const data = await fetchServers(placeId);
    const availableServers = data.data?.filter(s => s.playing < s.maxPlayers) || [];

    console.log(`Total available servers: ${availableServers.length}`);
    console.log(`Looking for ${limit} servers${filterRegion ? ` in region ${filterRegion}` : ''}`);

    const matchingServers = [];
    let attempted = 0;
    let index = skip;
    let checkedServers = [];

    // Keep searching until we find enough matching servers or run out of servers to check
    while (matchingServers.length < limit && index < availableServers.length && attempted < 100) {
      const server = availableServers[index];
      console.log(`Fetching region for server ${index}: ${server.playing}/${server.maxPlayers} players`);

      const region = await getServerRegion(placeId, server.id);
      attempted++;

      if (region && !region.error && region.ip) {
        const serverWithRegion = { ...server, region };
        checkedServers.push(serverWithRegion);
        
        // Only add to matchingServers if it matches the filter (or no filter specified)
        if (!filterRegion || region.countryCode === filterRegion.toUpperCase()) {
          matchingServers.push(serverWithRegion);
          console.log(`Added server ${server.id} from ${region.countryCode} (${matchingServers.length}/${limit})`);
        } else {
          console.log(`Skipped server ${server.id} from ${region.countryCode} (looking for ${filterRegion})`);
        }
      } else {
        console.log(`Failed to get region for server ${server.id}: ${region?.error || 'Unknown error'}`);
      }
      
      index++;
    }

    console.log(`Searched ${attempted} servers, found ${matchingServers.length} matching servers`);

    res.json({
      servers: matchingServers,
      total: matchingServers.length,
      debug: {
        attempted,
        checkedTotal: checkedServers.length,
        matchingTotal: matchingServers.length,
        searchedIndices: `${skip}-${index - 1}`
      }
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// === Start Server ===
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));