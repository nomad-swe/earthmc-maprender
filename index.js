const fs = require("fs");
const path = require("path");
const sharp = require("sharp");
const polygonClipping = require("polygon-clipping");
const { createCanvas, loadImage} = require("@napi-rs/canvas");

// Constants
const CAPITAL_RADIUS = 5000;
const TOWN_RADIUS = 1500;

const OVERLAY_OPACITY = 0.3;
const CIRCLE_SEGMENTS = 72;

const TILE_RETRIES = 3;
const TILE_REQUEST_LIMIT = 3;
const TILE_RETRY_DELAY = 1000;
const TILE_SIZE_PX = 512;
const CHUNK_WIDTH = 16;
const RANGE_LINE_WIDTH_BASE = 2;

const TOWN_BATCH = 100;
const MAX_ZOOM = 5;
const MAX_PX = 2048;

// URLS
const MAP_URL = "https://map.earthmc.net/tiles/minecraft_overworld";
const API_TOWN = "https://api.earthmc.net/v4/towns";
const API_NATION = "https://api.earthmc.net/v4/nations";

// Folders
const ROOT_DIR = __dirname;
const DATA_DIR = path.join(ROOT_DIR, "data");
const TILE_DIR = path.join(DATA_DIR, "tiles");
const MAP_DIR = path.join(DATA_DIR, "maps");

function checkDir(dirPath) {
    if (!fs.existsSync(dirPath)) {
        fs.mkdirSync(dirPath, {
            recursive: true
        });
    }
}

function chunkArray(items, size) {
    const out = [];
    for (let i = 0; i < items.length; i += size) {
        out.push(items.slice(i, i + size));
    }

    return out;
}

function getChunkPixelSize(tileScale) {
    return (CHUNK_WIDTH * TILE_SIZE_PX) / tileScale;
}

function getTileBoundsForChunkExtents(minCx, maxCx, minCz, maxCz, tileZoom) {
    const tileScale = TILE_SIZE_PX * 2 ** (MAX_ZOOM - tileZoom);
    const minBx = minCx * CHUNK_WIDTH;
    const maxBx = maxCx * CHUNK_WIDTH + (CHUNK_WIDTH - 1);
    const minBz = minCz * CHUNK_WIDTH;
    const maxBz = maxCz * CHUNK_WIDTH + (CHUNK_WIDTH - 1);

    return {
        tileScale,
        tMinX: Math.floor(minBx / tileScale),
        tMaxX: Math.floor(maxBx / tileScale),
        tMinZ: Math.floor(minBz / tileScale),
        tMaxZ: Math.floor(maxBz / tileScale)
    };
}

function getChunkBounds(claimChunks) {
    return {
        minChunkX: Math.min(...claimChunks.map(([chunkX]) => chunkX)),
        maxChunkX: Math.max(...claimChunks.map(([chunkX]) => chunkX)),
        minChunkZ: Math.min(...claimChunks.map(([, chunkZ]) => chunkZ)),
        maxChunkZ: Math.max(...claimChunks.map(([, chunkZ]) => chunkZ))
    };
}

function getTownClaim(towns) {
    return towns.flatMap((town) => town.coordinates.townBlocks);
}

function getCapital(towns) {
    const capitalTown = towns.find((town) => town.status.isCapital);
    if (capitalTown) return capitalTown;
    if (towns.length > 0) return towns[0];

    return null;
}

async function postJson(url, body) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 30000);
    let response;

    try {
        response = await fetch(url, {
            method: "POST",
            headers: {
                "Content-Type": "application/json"
            },
            body: JSON.stringify(body),
            signal: controller.signal
        });
    } finally {
        clearTimeout(timeoutId);
    }

    if (!response.ok) throw new Error(`POST ${url} failed: ${response.status} ${response.statusText}`);
    return await response.json();
}

async function fetchNationTowns(nationName) {
    const nations = await postJson(API_NATION, {
        query: [nationName],
        template: {
            name: true,
            capital: true,
            towns: true
        }
    });
    const nation = nations[0];
    if (!nation) return [];

    const townNames = nation.towns.map((town) => town.name).filter(Boolean);
    if (townNames.length === 0) return [];

    const batches = chunkArray(townNames, TOWN_BATCH);
    const allTowns = [];

    for (const batch of batches) {
        const towns = await postJson(API_TOWN, {
            query: batch,
            template: {
                name: true,
                nation: true,
                status: true,
                coordinates: true
            }
        });
        allTowns.push(...towns);
    }

    return allTowns;
}

function getCachedTilePath(zoom, x, z) {
    const zoomDir = path.join(TILE_DIR, String(zoom));
    checkDir(zoomDir);

    return path.join(zoomDir, `${x}_${z}.png`);
}

async function loadTileWithRetry(zoom, x, z) {
    const cachedPath = getCachedTilePath(zoom, x, z);
    const tileUrl = `${MAP_URL}/${zoom}/${x}_${z}.png`;

    if (fs.existsSync(cachedPath)) {
        return await loadImage(fs.readFileSync(cachedPath));
    }

    for (let attempt = 1; attempt <= TILE_RETRIES; attempt += 1) {
        try {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 30000);
            let response;

            try {
                response = await fetch(tileUrl, {
                    signal: controller.signal
                });
            } finally {
                clearTimeout(timeoutId);
            }

            if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);

            const arrayBuffer = await response.arrayBuffer();
            const buffer = Buffer.from(arrayBuffer);

            fs.writeFileSync(cachedPath, buffer);
            return await loadImage(buffer);
        } catch (error) {
            if (attempt === TILE_RETRIES) throw error;
            await new Promise((resolve) => setTimeout(resolve, TILE_RETRY_DELAY * 2 ** (attempt - 1)));
        }
    }

    throw new Error(`Tile: ${zoom}/${x}_${z}.png failed to load after: ${TILE_RETRIES} retries`);
}

async function drawBackgroundTiles(ctx, zoom, bounds) {
    const coords = [];
    for (let tileX = bounds.tMinX; tileX <= bounds.tMaxX; tileX += 1) {
        for (let tileZ = bounds.tMinZ; tileZ <= bounds.tMaxZ; tileZ += 1) {
            coords.push([tileX, tileZ]);
        }
    }

    let nextTileIndex = 0;

    async function drawNextTile() {
        while (nextTileIndex < coords.length) {
            const currentIndex = nextTileIndex;
            nextTileIndex += 1;

            const [tileX, tileZ] = coords[currentIndex];

            try {
                const img = await loadTileWithRetry(zoom, tileX, tileZ);
                ctx.drawImage(
                    img,
                    (tileX - bounds.tMinX) * TILE_SIZE_PX,
                    (tileZ - bounds.tMinZ) * TILE_SIZE_PX,
                    TILE_SIZE_PX,
                    TILE_SIZE_PX
                );
            } catch (error) {
                console.warn(`Tile failed ${zoom}/${tileX}_${tileZ}: ${error.message}`);
            }
        }
    }

    const tileWorkers = Math.min(TILE_REQUEST_LIMIT, coords.length);
    await Promise.all(Array.from({length: tileWorkers}, drawNextTile));
}

function buildClaimUnion(chunks, tileScale, tMinX, tMinZ) {
    const blockScale = getChunkPixelSize(tileScale);
    const chunkPolygons = chunks.map(([chunkX, chunkZ]) => {
        const x = ((chunkX * CHUNK_WIDTH) / tileScale - tMinX) * TILE_SIZE_PX;
        const z = ((chunkZ * CHUNK_WIDTH) / tileScale - tMinZ) * TILE_SIZE_PX;

        return [
            [
                [x, z],
                [x + blockScale, z],
                [x + blockScale, z + blockScale],
                [x, z + blockScale]
            ]
        ];
    });

    if (chunkPolygons.length === 0) {
        return [];
    }

    return polygonClipping.union(...chunkPolygons);
}

function circleToRing(centerX, centerY, radiusPx, points = CIRCLE_SEGMENTS) {
    const ring = [];
    for (let i = 0; i < points; i += 1) {
        const angle = (2 * Math.PI * i) / points;
        ring.push([
            centerX + radiusPx * Math.cos(angle),
            centerY + radiusPx * Math.sin(angle)
        ]);
    }

    ring.push(ring[0]);
    return ring;
}

function tracePolygonSet(ctx, polygonSet) {
    for (const polygon of polygonSet) {
        for (const ring of polygon) {
            if (ring.length === 0) {
                continue;
            }

            ctx.moveTo(ring[0][0], ring[0][1]);
            for (let i = 1; i < ring.length; i += 1) {
                ctx.lineTo(ring[i][0], ring[i][1]);
            }
            ctx.closePath();
        }
    }
}

function drawClaims(ctx, polygonSet, fillStyle, opacity, outlineWidth, drawOutline) {
    if (polygonSet.length === 0) {
        return;
    }

    ctx.save();
    ctx.beginPath();
    tracePolygonSet(ctx, polygonSet);
    ctx.fillStyle = fillStyle;
    ctx.globalAlpha = opacity;
    ctx.fill("evenodd");

    if (drawOutline) {
        ctx.globalAlpha = 1;
        ctx.strokeStyle = "#000000";
        ctx.lineWidth = outlineWidth;
        ctx.lineJoin = "round";
        ctx.lineCap = "round";
        ctx.stroke();
    }

    ctx.restore();
}

function darkenBackground(ctx, width, height) {
    ctx.save();
    ctx.fillStyle = "#000000";
    ctx.globalAlpha = OVERLAY_OPACITY;
    ctx.fillRect(0, 0, width, height);
    ctx.restore();
}

function createCanvasFromTileBounds(bounds) {
    const width = (bounds.tMaxX - bounds.tMinX + 1) * TILE_SIZE_PX;
    const height = (bounds.tMaxZ - bounds.tMinZ + 1) * TILE_SIZE_PX;
    return createCanvas(width, height);
}

// Save the map to a file
async function saveMap(canvas, outputPath) {
    if (canvas.width > MAX_PX || canvas.height > MAX_PX) {
        const scale = Math.min(MAX_PX / canvas.width, MAX_PX / canvas.height);

        const resized = createCanvas(
            Math.max(1, Math.round(canvas.width * scale)),
            Math.max(1, Math.round(canvas.height * scale))
        );

        const ctx = resized.getContext("2d");
        ctx.drawImage(canvas, 0, 0, resized.width, resized.height);
        canvas = resized;
    }

    const pngBuffer = canvas.toBuffer("image/png");
    const optimized = await sharp(pngBuffer).png({compressionLevel: 9, adaptiveFiltering: true, effort: 8}).toBuffer();
    fs.writeFileSync(outputPath, optimized);
}

async function renderClaimMap({towns, fillColor, opacity, drawOutline, blank, tileZoom}) {
    const claimChunks = getTownClaim(towns);
    const {minChunkX, maxChunkX, minChunkZ, maxChunkZ} = getChunkBounds(claimChunks);
    const bounds = getTileBoundsForChunkExtents(minChunkX, maxChunkX, minChunkZ, maxChunkZ, tileZoom);
    const canvas = createCanvasFromTileBounds(bounds);
    const ctx = canvas.getContext("2d");

    if (!blank) {
        await drawBackgroundTiles(ctx, tileZoom, bounds);
        darkenBackground(ctx, canvas.width, canvas.height);
    }

    const claimUnion = buildClaimUnion(claimChunks, bounds.tileScale, bounds.tMinX, bounds.tMinZ);
    const outlineWidth = Math.max(1, Math.floor(getChunkPixelSize(bounds.tileScale) / 4));

    drawClaims(ctx, claimUnion, fillColor, opacity, outlineWidth, drawOutline);
    return canvas;
}

async function renderRangeMap({towns, tileZoom, borderSize}) {
    const claimChunks = getTownClaim(towns);
    let {minChunkX, maxChunkX, minChunkZ, maxChunkZ} = getChunkBounds(claimChunks);

    const capitalTown = getCapital(towns);
    const capitalSpawn = capitalTown.coordinates.spawn;

    for (const town of towns) {
        const {x, z} = town.coordinates.spawn;
        const radius = town.status.isCapital ? CAPITAL_RADIUS : TOWN_RADIUS;

        minChunkX = Math.min(minChunkX, Math.floor((x - radius) / CHUNK_WIDTH));
        maxChunkX = Math.max(maxChunkX, Math.ceil((x + radius) / CHUNK_WIDTH));
        minChunkZ = Math.min(minChunkZ, Math.floor((z - radius) / CHUNK_WIDTH));
        maxChunkZ = Math.max(maxChunkZ, Math.ceil((z + radius) / CHUNK_WIDTH));
    }

    const bounds = getTileBoundsForChunkExtents(minChunkX, maxChunkX, minChunkZ, maxChunkZ, tileZoom);
    const canvas = createCanvasFromTileBounds(bounds);
    const ctx = canvas.getContext("2d");

    await drawBackgroundTiles(ctx, tileZoom, bounds);
    darkenBackground(ctx, canvas.width, canvas.height);

    const claimUnion = buildClaimUnion(claimChunks, bounds.tileScale, bounds.tMinX, bounds.tMinZ);
    const claimOutlineWidth = Math.max(1, Math.floor(getChunkPixelSize(bounds.tileScale) / 4));
    drawClaims(ctx, claimUnion, "#ffffff", 1, claimOutlineWidth, true);

    const pxPerBlock = TILE_SIZE_PX / bounds.tileScale;
    const baseLineWidth = Math.max(1, Math.floor(RANGE_LINE_WIDTH_BASE * (tileZoom + 1)));
    const rangeLineWidth = baseLineWidth * borderSize;
    const circlePolygons = [];

    const cx = ((capitalSpawn.x / bounds.tileScale) - bounds.tMinX) * TILE_SIZE_PX;
    const cz = ((capitalSpawn.z / bounds.tileScale) - bounds.tMinZ) * TILE_SIZE_PX;
    circlePolygons.push([circleToRing(cx, cz, CAPITAL_RADIUS * pxPerBlock)]);

    for (const town of towns) {
        if (town.status.isCapital) continue;

        const {x, z} = town.coordinates.spawn;
        const cx = ((x / bounds.tileScale) - bounds.tMinX) * TILE_SIZE_PX;
        const cz = ((z / bounds.tileScale) - bounds.tMinZ) * TILE_SIZE_PX;
        circlePolygons.push([circleToRing(cx, cz, TOWN_RADIUS * pxPerBlock)]);
    }

    if (circlePolygons.length > 0) {
        const unionedRange = polygonClipping.union(...circlePolygons);
        ctx.save();
        ctx.beginPath();
        tracePolygonSet(ctx, unionedRange);
        ctx.strokeStyle = "#ffffff";
        ctx.lineWidth = rangeLineWidth;
        ctx.lineJoin = "round";
        ctx.lineCap = "round";
        ctx.stroke();
        ctx.restore();
    }

    return canvas;
}

async function generateNationMap({nationName = "France", fill = "#ffffff", opacity = 1, drawOutline = true, blank = false, tileZoom = 3, outputPath} = {}) {
    const towns = await fetchNationTowns(nationName);
    const canvas = await renderClaimMap({towns, fillColor: fill, opacity, drawOutline, blank, tileZoom});

    let finalOutputPath = outputPath;
    if (!finalOutputPath) {
        finalOutputPath = blank ? path.join(MAP_DIR, "blank_map.png") : path.join(MAP_DIR, "nation_map.png");
    }

    await saveMap(canvas, finalOutputPath);
    return {canvas, outputPath: finalOutputPath, towns};
}

async function generateRangeMap({nationName = "France", tileZoom = 3, borderSize = 1, outputPath} = {}) {
    const towns = await fetchNationTowns(nationName);
    const canvas = await renderRangeMap({towns, tileZoom, borderSize});

    let finalOutputPath = outputPath;
    if (!finalOutputPath) {
        finalOutputPath = path.join(MAP_DIR, "range_map.png");
    }

    await saveMap(canvas, finalOutputPath);
    return { canvas, outputPath: finalOutputPath, towns};
}

(async () => {
    checkDir(DATA_DIR);
    checkDir(TILE_DIR);
    checkDir(MAP_DIR);

    // The different maps which all contains some dafault values
    // calling the method with for example generateNationMap({ nationName: "Switzerland" })
    // will generate a nation map for Switzerland rather than France 
    await generateNationMap(); 			    // Normal nation map
    await generateNationMap({blank: true}); // Blank nation map  
    await generateRangeMap(); 				// Nation range map
})().catch((error) => {
    console.error(error);
    process.exit(1);
});