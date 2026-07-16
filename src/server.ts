import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  Tool,
} from '@modelcontextprotocol/sdk/types.js';

import { initDb } from './db/client.js';
import { searchSchema, handleSearchEntraPodcasts } from './tools/search.js';
import { getEpisodeSchema, handleGetEpisode } from './tools/get-episode.js';
import { listEpisodesSchema, handleListEpisodes } from './tools/list-episodes.js';
import { listGuestsSchema, handleListGuests } from './tools/list-guests.js';
import { getGuestSchema, handleGetGuest } from './tools/get-guest.js';
import { findToolMentionsSchema, handleFindToolMentions } from './tools/find-tool-mentions.js';

const TOOLS: Tool[] = [
  {
    name: 'search_entra_podcasts',
    description:
      'Search transcripts of the Entra.Chat podcast (Merill Fernando\'s Microsoft Entra podcast on YouTube) ' +
      'using natural language or keywords. Returns transcript excerpts with episode metadata, guest names, ' +
      'and timestamped YouTube deep links that start playback at the relevant moment. ' +
      'Hybrid mode fuses BM25 keyword search with semantic vector search via Reciprocal Rank Fusion ' +
      '(semantic requires OPENAI_API_KEY; keyword works with no configuration).',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Natural language question or keywords to search for',
        },
        limit: {
          type: 'number',
          description: 'Maximum number of results to return (default: 10, max: 50)',
          default: 10,
        },
        mode: {
          type: 'string',
          enum: ['hybrid', 'semantic', 'keyword'],
          description: 'Search mode: hybrid (default), semantic-only, or keyword-only (BM25)',
          default: 'hybrid',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'get_episode',
    description:
      'Retrieve a specific Entra.Chat episode by YouTube video ID, episode number, or publication date. ' +
      'Returns full metadata (guests with profile links, chapters with timestamped links) and the ' +
      'complete transcript with [mm:ss] time markers.',
    inputSchema: {
      type: 'object',
      properties: {
        video_id: {
          type: 'string',
          description: 'YouTube video ID (11 characters)',
        },
        episode_number: {
          type: 'number',
          description: 'Episode number (e.g. 12)',
        },
        date: {
          type: 'string',
          description:
            'Date in YYYY-MM-DD or YYYY-MM format to find the nearest episode (e.g. "2026-03" or "2026-03-15")',
        },
      },
    },
  },
  {
    name: 'list_episodes',
    description:
      'Browse the Entra.Chat episode archive with optional year/month/guest filtering. ' +
      'Returns episode number, title, date, duration, guests, and URL. ' +
      'Use this to discover what episodes exist before using get_episode or search_entra_podcasts.',
    inputSchema: {
      type: 'object',
      properties: {
        year: {
          type: 'number',
          description: 'Filter by year (e.g. 2026)',
        },
        month: {
          type: 'number',
          description: 'Filter by month number 1–12 (e.g. 3 for March). Requires year.',
        },
        guest: {
          type: 'string',
          description: 'Filter to episodes featuring a guest whose name contains this text',
        },
        limit: {
          type: 'number',
          description: 'Maximum episodes to return (default: 50)',
          default: 50,
        },
        offset: {
          type: 'number',
          description: 'Pagination offset (default: 0)',
          default: 0,
        },
      },
    },
  },
  {
    name: 'list_guests',
    description:
      'Browse the directory of Entra.Chat podcast guests. Returns each guest with profile links ' +
      '(LinkedIn, Twitter/X, GitHub, Bluesky, website), how many episodes they appeared on, and their ' +
      'latest appearance date. Use get_guest for a full per-guest episode list.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Optional filter — only guests whose name contains this text',
        },
        limit: {
          type: 'number',
          description: 'Maximum guests to return (default: 50, max: 200)',
          default: 50,
        },
        offset: {
          type: 'number',
          description: 'Pagination offset (default: 0)',
          default: 0,
        },
      },
    },
  },
  {
    name: 'get_guest',
    description:
      'Get a specific Entra.Chat guest by name: their profile links (LinkedIn, Twitter/X, GitHub, ' +
      'Bluesky, website) and every episode they appeared on, enumerated with episode number, title, ' +
      'date, and URL. Partial names match; returning guests show all their appearances.',
    inputSchema: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'Guest name to look up (case-insensitive; partial names match)',
        },
      },
      required: ['name'],
    },
  },
  {
    name: 'find_tool_mentions',
    description:
      'Find community tools and open-source projects discussed on Entra.Chat episodes. ' +
      'Returns tool names, the episodes where they were discussed, and timestamped YouTube links ' +
      'to hear the discussion. Optionally filter by keyword.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description:
            'Optional filter — search by tool name or keyword (e.g. "Maester", "PowerShell", "Conditional Access")',
        },
        limit: {
          type: 'number',
          description: 'Maximum number of tool mentions to return (default: 20)',
          default: 20,
        },
      },
    },
  },
];

// Resolve the package version from package.json so it is defined in one place.
// Compiled layout: dist/src/server.js → ../../package.json; ts-node dev: src/server.ts → ../package.json
function getPackageVersion(): string {
  for (const p of ['../package.json', '../../package.json']) {
    try {
      return require(p).version;
    } catch {
      // try next path
    }
  }
  return '0.0.0';
}

export async function createServer(): Promise<{ server: Server; transport: StdioServerTransport }> {
  // Initialise the database (download if needed)
  await initDb();

  const server = new Server(
    {
      name: 'entra-news-podcast-mcp',
      version: getPackageVersion(),
    },
    {
      capabilities: {
        tools: {},
      },
    }
  );

  // List available tools
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS,
  }));

  // Handle tool calls
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    try {
      let text: string;

      switch (name) {
        case 'search_entra_podcasts': {
          const parsed = searchSchema.parse(args ?? {});
          text = await handleSearchEntraPodcasts(parsed);
          break;
        }
        case 'get_episode': {
          const parsed = getEpisodeSchema.parse(args ?? {});
          text = handleGetEpisode(parsed);
          break;
        }
        case 'list_episodes': {
          const parsed = listEpisodesSchema.parse(args ?? {});
          text = handleListEpisodes(parsed);
          break;
        }
        case 'list_guests': {
          const parsed = listGuestsSchema.parse(args ?? {});
          text = handleListGuests(parsed);
          break;
        }
        case 'get_guest': {
          const parsed = getGuestSchema.parse(args ?? {});
          text = handleGetGuest(parsed);
          break;
        }
        case 'find_tool_mentions': {
          const parsed = findToolMentionsSchema.parse(args ?? {});
          text = handleFindToolMentions(parsed);
          break;
        }
        default:
          return {
            content: [{ type: 'text', text: `Unknown tool: ${name}` }],
            isError: true,
          };
      }

      return {
        content: [{ type: 'text', text }],
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: 'text', text: `Error: ${message}` }],
        isError: true,
      };
    }
  });

  const transport = new StdioServerTransport();
  return { server, transport };
}
