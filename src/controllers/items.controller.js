const itemsService = require('../services/items.service');
const { toItemSummary, toItemDetail } = require('../dto/item.mappers');
const redis = require('../lib/redis');

const DUE_ITEMS_CACHE_TTL_SECONDS = 300;

async function createItem(req, res, next) {
  try {
    const item = await itemsService.createItem(req.userId, req.body);
    res.status(201).json(toItemDetail(item));
  } catch (err) {
    next(err);
  }
}

async function listItems(req, res, next) {
  try {
    const { status, page, limit } = req.validatedQuery;
    const { items, total } = await itemsService.listItems(req.userId, { status, page, limit });
    res.json({ items: items.map(toItemSummary), page, limit, total });
  } catch (err) {
    next(err);
  }
}

async function getItem(req, res, next) {
  try {
    const item = await itemsService.getItemById(req.userId, req.params.id);
    res.json(toItemDetail(item));
  } catch (err) {
    next(err);
  }
}

async function updateItem(req, res, next) {
  try {
    const item = await itemsService.updateItemText(req.userId, req.params.id, req.body.text);
    res.json(toItemDetail(item));
  } catch (err) {
    next(err);
  }
}

async function deleteItem(req, res, next) {
  try {
    await itemsService.softDeleteItem(req.userId, req.params.id);
    res.status(204).send();
  } catch (err) {
    next(err);
  }
}

// "Due items" is the read a user hits at the start of every review session,
// so it's the one worth a cache-on-failure fallback: if the database read
// itself fails (down/timed out), serve the last known-good list from Redis
// instead of a hard error. This is NOT a cache-aside/read-through cache --
// the database is still hit on every request; Redis is only ever read when
// the database read throws.
async function listDue(req, res, next) {
  const cacheKey = `due-items:${req.userId}:${req.validatedQuery.date}`;
  try {
    const items = await itemsService.listDueItems(req.userId, req.validatedQuery.date);
    const payload = items.map(toItemDetail);
    if (redis) redis.set(cacheKey, JSON.stringify(payload), 'EX', DUE_ITEMS_CACHE_TTL_SECONDS).catch(() => {});
    res.json(payload);
  } catch (err) {
    if (redis) {
      const cached = await redis.get(cacheKey).catch(() => null);
      if (cached) {
        console.error('listDue: database read failed, serving cached fallback', err);
        res.set('X-Cache', 'stale-fallback');
        return res.json(JSON.parse(cached));
      }
    }
    next(err);
  }
}

async function reviewItem(req, res, next) {
  try {
    const item = await itemsService.reviewItem(req.userId, req.params.id, req.body.date);
    res.json(toItemDetail(item));
  } catch (err) {
    next(err);
  }
}

async function skipItem(req, res, next) {
  try {
    const item = await itemsService.skipItem(req.userId, req.params.id, req.body.date);
    res.json(toItemDetail(item));
  } catch (err) {
    next(err);
  }
}

async function reviewHistory(req, res, next) {
  try {
    const year = req.validatedQuery.year ?? new Date().getFullYear();
    const days = await itemsService.getReviewHistory(req.userId, year);
    res.json({ year, days });
  } catch (err) {
    next(err);
  }
}

module.exports = {
  createItem,
  listItems,
  getItem,
  updateItem,
  deleteItem,
  listDue,
  reviewItem,
  skipItem,
  reviewHistory,
};
