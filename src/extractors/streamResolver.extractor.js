/*
 * ======= • ======= • ======= • ======= • =======• =======
 * AniKotoAPI — streamResolver.extractor.js
 * Repository: https://github.com/Shineii86/AniKotoAPI
 *
 * @description
 *   Resolves actual streaming video URLs (m3u8/mp4) from embed player URLs.
 *   Follows the chain: vidtube.site embed → megaplay API → m3u8 playlist.
 *   Supports quality selection and subtitle extraction.
 *
 * @exports
 *   resolveStreamUrl, resolveStreamUrls, parseM3u8Qualities
 *
 * @author  Shinei Nouzen
 * @license MIT
 * ======= • ======= • ======= • ======= • =======• =======
 */

import axios from "axios";
import { headers } from "../configs/header.config.js";

// ══════════════════════════════════════════════════════════════
// STREAM RESOLVER
// ══════════════════════════════════════════════════════════════

// Server name normalization map
const SERVER_NAME_MAP = {
  "VidPlay-1": "vidplay",
  "VidPlay-2": "vidplay",
  "HD-1": "hd",
  "HD-2": "hd",
  "Vidstream-1": "vidstream",
  "Vidstream-2": "vidstream",
  "VidCloud-1": "vidcloud",
  "VidCloud-2": "vidcloud",
  "StreamTape-1": "streamtape",
  "StreamTape-2": "streamtape",
};

// Embed domain to API domain mapping
// NOTE: megaplay-1.buzz no longer resolves (see streamProxy.helper.js), so every embed
// host is mapped to megaplay.buzz. Unknown hosts are queried on their own domain.
const EMBED_API_MAP = {
  "vidtube.site": "megaplay.buzz",
  "vid-tube.site": "megaplay.buzz",
  "vidplay.site": "megaplay.buzz",
  "megaplay.buzz": "megaplay.buzz",
  "embed.bunkrerrer.com": "megaplay.buzz",
};

// Endpoints tried in order for the real stream (the player has used both shapes)
const SOURCE_ENDPOINTS = [
  (id) => `/stream/getSources?id=${id}`,
  (id) => `/ajax/sources/${id}`,
];

// ---- FEATURE: Read the stream URL out of any known response shape ----
/**
 * Players answer with {source}, {url}, {file}, {sources:"…"}, {sources:{file}} or
 * {sources:[{file,type}]}. Returns { url, type } or null.
 */
const pickSource = (apiData) => {
  if (!apiData || typeof apiData !== "object") return null;
  let url = apiData.source || apiData.url || apiData.file || null;
  let type = apiData.type || null;
  const src = apiData.sources;
  if (!url && src) {
    if (typeof src === "string") url = src;
    else if (Array.isArray(src)) {
      const first = src.find((x) => x && (x.file || x.url || x.src)) || null;
      if (first) { url = first.file || first.url || first.src; type = type || first.type || null; }
    } else if (typeof src === "object") {
      url = src.file || src.url || src.src || null;
      type = type || src.type || null;
    }
  }
  if (typeof url !== "string" || !/^https?:\/\//i.test(url)) return null;
  return { url, type: type || (/\.m3u8(\?|$)/i.test(url) ? "hls" : "mp4") };
};

// ---- FEATURE: Last-resort scan for a playlist link inside any text/HTML/JSON body ----
const scanForStream = (text) => {
  if (typeof text !== "string" || !text) return null;
  const clean = text.replace(/\\\//g, "/").replace(/\\u0026/g, "&");
  const m = clean.match(/https?:\/\/[^"'\s<>\\]+\.m3u8[^"'\s<>\\]*/i)
    || clean.match(/https?:\/\/[^"'\s<>\\]+\.mp4[^"'\s<>\\]*/i);
  return m ? { url: m[0], type: /\.m3u8/i.test(m[0]) ? "hls" : "mp4" } : null;
};

// ---- FEATURE: Friendly quality label ----
/** 1080 → "1080p". Heights are kept real (360p, 480p, 720p, 1080p ...); with no RESOLUTION it falls back to bandwidth. */
const labelFor = (height, bandwidth) => {
  if (height) return `${height}p`;
  if (bandwidth >= 4000000) return "1080p";
  if (bandwidth >= 2000000) return "720p";
  if (bandwidth >= 900000) return "480p";
  if (bandwidth > 0) return "360p";
  return "Auto";
};

// ---- FEATURE: Server Name Normalization ----
/**
 * Normalizes server display names to clean identifiers
 * @param {string} name - Raw server name (e.g., "VidPlay-1")
 * @returns {string} Normalized name (e.g., "vidplay")
 */
const normalizeServerName = (name) => {
  if (!name) return "unknown";
  return SERVER_NAME_MAP[name] || name.toLowerCase().replace(/[-\s]+\d+$/, "").trim();
};

// ---- FEATURE: Stream URL Resolution ----
/**
 * Resolves the actual video stream URL from an embed player page.
 * Extracts data-id from the embed HTML, then queries the megaplay API.
 *
 * @param {string} embedUrl - The embed player URL (e.g., vidtube.site/stream/...)
 * @param {object} [options] - Resolution options
 * @param {boolean} [options.followRedirects=true] - Follow HTTP redirects
 * @param {number} [options.timeout=10000] - Request timeout in ms
 * @returns {Promise<Object>} Object with url, qualities, skipData, type
 *
 * @example
 *   const resolved = await resolveStreamUrl("https://vidtube.site/stream/...");
 *   console.log(resolved.url);      // m3u8 URL
 *   console.log(resolved.qualities); // [{ label: "720p", url: "..." }]
 */
const resolveStreamUrl = async (embedUrl, options = {}) => {
  const { followRedirects = true, timeout = 10000 } = options;

  try {
    // NOTE: Extract the embed page to find data-id and API domain
    const embedResponse = await axios.get(embedUrl, {
      headers: {
        ...headers,
        "Referer": "https://anikototv.to/",
        "Origin": "https://anikototv.to",
      },
      timeout,
      maxRedirects: followRedirects ? 5 : 0,
    });

    const embedHtml = typeof embedResponse.data === "string"
      ? embedResponse.data
      : String(embedResponse.data);

    // NOTE: Extract data attributes from the player div
    const dataId = embedHtml.match(/data-id\s*=\s*["']?(\d+)/)?.[1];
    const realId = embedHtml.match(/data-realid\s*=\s*["']([^"']+)["']/)?.[1];
    const mediaId = embedHtml.match(/data-mediaid\s*=\s*["']([^"']+)["']/)?.[1];

    if (!dataId) {
      return {
        url: null,
        qualities: [],
        skipData: null,
        type: null,
        error: "Could not extract player data-id from embed page",
      };
    }

    // NOTE: Determine API domain from embed URL or extract from page
    const embedDomain = new URL(embedUrl).hostname;
    const apiDomain = EMBED_API_MAP[embedDomain] || embedDomain;

    // NOTE: Query the player API for the actual stream URL (tries each known endpoint)
    let apiData = null;
    let picked = scanForStream(embedHtml);   // some players put the link straight in the page
    const attempts = [];
    if (picked) attempts.push({ endpoint: "embed-page-scan", ok: true });
    for (const build of (picked ? [] : SOURCE_ENDPOINTS)) {
      const endpoint = `https://${apiDomain}${build(dataId)}`;
      try {
        const apiResponse = await axios.get(endpoint, {
          headers: {
            ...headers,
            "Accept": "application/json, text/plain, */*",
            "X-Requested-With": "XMLHttpRequest",
            "Referer": embedUrl,
            "Origin": `https://${embedDomain}`,
          },
          timeout,
          validateStatus: () => true,   // keep non-200 bodies so we can see WHY it failed
        });
        const rawBody = typeof apiResponse.data === "string"
          ? apiResponse.data
          : JSON.stringify(apiResponse.data || {});
        const parsed = typeof apiResponse.data === "string"
          ? (() => { try { return JSON.parse(apiResponse.data); } catch { return {}; } })()
          : apiResponse.data;
        picked = pickSource(parsed) || scanForStream(rawBody);
        attempts.push({
          endpoint,
          ok: !!picked,
          status: apiResponse.status,
          contentType: String(apiResponse.headers?.["content-type"] || ""),
          encrypted: !!(parsed && (parsed.encrypted || typeof parsed.sources === "string" && !/^https?:/i.test(parsed.sources))),
          preview: rawBody.slice(0, 220),
        });
        if (picked) { apiData = parsed; break; }
      } catch (e) {
        attempts.push({ endpoint, ok: false, error: e.message });
      }
    }

    if (!picked) {
      return {
        url: null, qualities: [], skipData: null, type: null,
        error: "Player API returned no stream URL",
        embedUrl,
        dataId,
        attempts,
      };
    }

    const streamUrl = picked.url;
    const streamType = picked.type;

    // NOTE: Parse m3u8 qualities if it's an HLS stream (Referer = embed, then the player host)
    let qualities = [];
    if (streamType === "hls") {
      for (const referer of [embedUrl, `https://${embedDomain}/`, `https://${apiDomain}/`, "https://anikototv.to/"]) {
        qualities = await parseM3u8Qualities(streamUrl, {
          headers: { ...headers, "Referer": referer, "Origin": new URL(referer).origin },
          timeout,
        });
        if (qualities.length) break;
      }
    }

    // NOTE: Extract subtitles if available
    const subtitles = extractSubtitles(apiData);

    return {
      url: streamUrl,
      masterUrl: streamUrl,
      type: streamType,
      qualities,
      // Flat list ready to play: every quality as its own direct link
      sources: qualities.length
        ? qualities.map((q) => ({ quality: q.label, height: q.height, type: streamType, url: q.url }))
        : [{ quality: "Auto", height: 0, type: streamType, url: streamUrl }],
      subtitles,
      skipData: apiData?.skip_data || (apiData?.intro || apiData?.outro ? { intro: apiData.intro || null, outro: apiData.outro || null } : null),
      dataId,
      realId,
      mediaId,
      backup: apiData?.backup || null,
    };
  } catch (error) {
    return {
      url: null,
      qualities: [],
      skipData: null,
      type: null,
      error: error.message,
    };
  }
};

// ---- FEATURE: Batch Stream URL Resolution ----
/**
 * Resolves stream URLs for multiple episodes in batch
 * @param {string} embedUrl - The embed player URL
 * @param {object} [options] - Resolution options
 * @returns {Promise<Object>} Batch resolution result
 */
const resolveStreamUrls = async (embedUrl, options = {}) => {
  try {
    const resolved = await resolveStreamUrl(embedUrl, options);
    return resolved;
  } catch (error) {
    return { url: null, error: error.message };
  }
};

// ══════════════════════════════════════════════════════════════
// M3U8 PARSER
// ══════════════════════════════════════════════════════════════

// ---- FEATURE: M3U8 Quality Parser ----
/**
 * Parses an M3U8 playlist to extract available quality options.
 * Supports both master playlists (multiple qualities) and media playlists.
 *
 * @param {string} m3u8Url - URL of the M3U8 playlist
 * @param {object} [options] - Fetch options
 * @param {object} [options.headers] - Custom headers
 * @param {number} [options.timeout=10000] - Request timeout
 * @returns {Promise<Array<Object>>} Array of quality objects
 *
 * @example
 *   const qualities = await parseM3u8Qualities("https://example.com/master.m3u8");
 *   qualities.forEach(q => console.log(`${q.label}: ${q.url}`));
 */
const parseM3u8Qualities = async (m3u8Url, options = {}) => {
  const { headers: customHeaders = {}, timeout = 10000 } = options;

  try {
    const response = await axios.get(m3u8Url, {
      headers: { ...headers, ...customHeaders },
      timeout,
    });

    const content = typeof response.data === "string"
      ? response.data
      : String(response.data);

    const qualities = [];
    const lines = content.split("\n").map((l) => l.trim());

    // NOTE: Parse master playlist (contains #EXT-X-STREAM-INF)
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].startsWith("#EXT-X-STREAM-INF:")) {
        const attrs = lines[i].substring("#EXT-X-STREAM-INF:".length);
        const bandwidth = parseInt(attrs.match(/BANDWIDTH=(\d+)/)?.[1] || "0");
        const resolution = attrs.match(/RESOLUTION=(\d+x\d+)/)?.[1] || "";
        const [width, height] = resolution.split("x").map(Number);
        const nextLine = lines[i + 1];

        if (nextLine && !nextLine.startsWith("#")) {
          // NOTE: Resolve relative URLs against base M3U8 URL
          const qualityUrl = nextLine.startsWith("http")
            ? nextLine
            : new URL(nextLine, m3u8Url).href;

          qualities.push({
            label: labelFor(height, bandwidth),
            width: width || 0,
            height: height || 0,
            bandwidth,
            url: qualityUrl,
          });
        }
      }
    }

    // NOTE: If no qualities found, it's likely a single-quality stream
    if (qualities.length === 0 && content.includes("#EXTINF")) {
      qualities.push({
        label: "default",
        width: 0,
        height: 0,
        bandwidth: 0,
        url: m3u8Url,
      });
    }

    // NOTE: Several rungs can share one height (different bitrates) - keep the best of each
    const best = new Map();
    for (const q of qualities) {
      const key = q.height || q.label;
      if (!best.has(key) || q.bandwidth > best.get(key).bandwidth) best.set(key, q);
    }
    const unique = [...best.values()];

    // NOTE: Sort by resolution/bandwidth descending (highest first)
    unique.sort((a, b) => (b.height || b.bandwidth) - (a.height || a.bandwidth));

    return unique;
  } catch (error) {
    return [];
  }
};

// ══════════════════════════════════════════════════════════════
// SUBTITLE EXTRACTOR
// ══════════════════════════════════════════════════════════════

// ---- FEATURE: Subtitle Track Extractor ----
/**
 * Extracts subtitle information from API response data
 * @param {object} apiData - The megaplay API response
 * @returns {Array<Object>} Array of subtitle objects
 */
const extractSubtitles = (apiData) => {
  const subtitles = [];

  // NOTE: Subtitles may be in different formats depending on the source
  if (apiData?.subtitles && Array.isArray(apiData.subtitles)) {
    for (const sub of apiData.subtitles) {
      subtitles.push({
        label: sub.label || sub.language || "Unknown",
        language: sub.code || sub.language || "unknown",
        url: sub.url || sub.file || null,
        format: sub.format || "srt",
      });
    }
  }

  // NOTE: Some sources embed subtitles in tracks array
  if (apiData?.tracks && Array.isArray(apiData.tracks)) {
    for (const track of apiData.tracks) {
      if (["subtitles", "captions"].includes(track.kind) || track.type === "subtitles") {
        subtitles.push({
          label: track.label || track.language || "Unknown",
          language: track.srclang || track.language || "unknown",
          url: track.file || track.src || null,
          format: (track.file || track.src || "").split("?")[0].split(".").pop() || track.format || "vtt",
          default: !!track.default,
        });
      }
    }
  }

  return subtitles;
};

export { resolveStreamUrl, resolveStreamUrls, parseM3u8Qualities, normalizeServerName, extractSubtitles, pickSource };

// ══════════════════════════════════════════════════════════════ END: streamResolver.extractor.js
