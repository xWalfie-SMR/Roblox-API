const express = require("express");
const cors = require("cors");
require("dotenv").config();

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;

const serverEndpoint = "https://games.roblox.com/v1/games/";
const presenceEndpoint = "https://presence.roblox.com/v1/presence/users";

const cookie = process.env.ROBLOX_COOKIE;

// Helper to format servers with join links as plain text
function formatServersWithJoinLinks(servers, placeId) {
  let text = `Total Servers: ${servers.length}\n\n`;

  servers.forEach((server, index) => {
    text += `Server ${index + 1}:\n`;
    text += `  ID: ${server.id}\n`;
    text += `  Players: ${server.playing}/${server.maxPlayers}\n`;
    text += `  FPS: ${server.fps.toFixed(2)}\n`;
    text += `  Ping: ${server.ping}ms\n`;
    text += `  Player Tokens: ${server.playerTokens?.length || 0}\n`;
    text += `  Join Link: roblox://experiences/start?placeId=${placeId}&gameInstanceId=${server.id}\n`;
    text += `\n`;
  });

  return text;
}

// Get servers
app.get("/api/servers/:placeId", async (req, res) => {
  const { placeId } = req.params;
  const limit = req.query.limit ? parseInt(req.query.limit) : null;
  const parsed = req.query.parsed === "true";

  try {
    let servers = [];
    let cursor = null;

    while (true) {
      const url = `${serverEndpoint}${placeId}/servers/0?sortOrder=Desc&limit=100${
        cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""
      }`;

      const response = await fetch(url, {
        headers: { Cookie: cookie },
      });
      const data = await response.json();

      if (data.data) {
        servers = servers.concat(data.data);
      }

      if (limit && servers.length >= limit) {
        servers = servers.slice(0, limit);
        break;
      }

      if (!data.nextPageCursor) break;
      cursor = data.nextPageCursor;
    }

    if (parsed) {
      res.set("Content-Type", "text/plain");
      res.send(formatServersWithJoinLinks(servers, placeId));
    } else {
      res.json({
        servers,
        totalServers: servers.length,
      });
    }
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Test authentication
app.get("/api/test-auth", async (req, res) => {
  const testRes = await fetch(
    "https://users.roblox.com/v1/users/authenticated",
    {
      headers: { Cookie: cookie },
    }
  );
  const testData = await testRes.json();
  res.json(testData);
});

// POST filtered servers (friends only) - AGGRESSIVE SEARCH
app.post("/api/servers/filtered/:placeId", async (req, res) => {
  const { placeId } = req.params;
  const { friendIds, parsed } = req.body;

  if (!friendIds || friendIds.length === 0) {
    return res.status(400).json({
      error: "friendIds required for filtered endpoint",
    });
  }

  try {
    const csrfRes = await fetch("https://auth.roblox.com/v2/logout", {
      method: "POST",
      headers: { Cookie: cookie },
    });
    const csrfToken = csrfRes.headers.get("x-csrf-token");

    const presenceRes = await fetch(presenceEndpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: cookie,
        "x-csrf-token": csrfToken,
      },
      body: JSON.stringify({ userIds: friendIds }),
    });
    const presenceData = await presenceRes.json();

    const friendGameIds = new Set(
      presenceData.userPresences
        .filter((p) => p.placeId?.toString() === placeId && p.gameId)
        .map((p) => p.gameId)
    );

    let matchingServers = [];
    let allServers = new Map(); // Use Map to avoid duplicates
    let totalSearched = 0;
    let pages = 0;

    // Try multiple sort orders to get different server sets
    const sortOrders = ["Desc", "Asc"];

    for (const sortOrder of sortOrders) {
      let cursor = null;
      let pagesForThisSort = 0;

      console.log(`\n--- Searching with sortOrder: ${sortOrder} ---`);

      while (pagesForThisSort < 20) {
        // Max 20 pages per sort order
        const url = `${serverEndpoint}${placeId}/servers/0?sortOrder=${sortOrder}&excludeFullGames=false&limit=100${
          cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""
        }`;

        const serverRes = await fetch(url, {
          headers: { Cookie: cookie },
        });
        const serverData = await serverRes.json();

        if (serverData.data) {
          for (const server of serverData.data) {
            if (!allServers.has(server.id)) {
              allServers.set(server.id, server);
              totalSearched++;

              if (friendGameIds.has(server.id)) {
                matchingServers.push(server);
                console.log(`Server with friend found: ${server.id}`);
              }
            }
          }
        }

        pages++;
        pagesForThisSort++;
        console.log(
          `Page ${pages} (${sortOrder}): ${
            serverData.data?.length || 0
          } servers, unique total: ${allServers.size}`
        );

        // Found all friends
        if (matchingServers.length >= friendIds.length) {
          console.log(`Found all ${friendIds.length} friends!`);
          break;
        }

        if (!serverData.nextPageCursor) {
          console.log(`No more pages for ${sortOrder}`);
          break;
        }

        cursor = serverData.nextPageCursor;
      }

      // If we found all friends, stop trying other sort orders
      if (matchingServers.length >= friendIds.length) break;
    }

    console.log(
      `\nFinal: Searched ${totalSearched} servers across ${pages} pages`
    );

    if (parsed) {
      let text = formatServersWithJoinLinks(matchingServers, placeId);

      text += `\nFriend Presences:\n`;
      presenceData.userPresences.forEach((p) => {
        text += `  User ${p.userId}: ${p.lastLocation || "Unknown"}\n`;
        if (p.gameId) {
          text += `    Game ID: ${p.gameId}\n`;
          text += `    Join Link: roblox://experiences/start?placeId=${p.placeId}&gameInstanceId=${p.gameId}\n`;
        }
      });

      text += `\nDebug: Searched ${totalSearched} servers across ${pages} pages\n`;

      res.set("Content-Type", "text/plain");
      res.send(text);
    } else {
      res.json({
        servers: matchingServers,
        presences: presenceData.userPresences,
        joinLinks: presenceData.userPresences
          .filter((p) => p.gameId && p.placeId?.toString() === placeId)
          .map((p) => ({
            userId: p.userId,
            joinUrl: `roblox://experiences/start?placeId=${p.placeId}&gameInstanceId=${p.gameId}`,
          })),
        debug: {
          totalServersSearched: totalSearched,
          uniqueServers: allServers.size,
          pagesSearched: pages,
          lookingFor: Array.from(friendGameIds),
        },
      });
    }
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
