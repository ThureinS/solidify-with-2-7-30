const itemsService = require('../services/items.service');
const { toItemSummary, toItemDetail } = require('../dto/item.mappers');

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

async function listDue(req, res, next) {
  try {
    const items = await itemsService.listDueItems(req.userId, req.validatedQuery.date);
    res.json(items.map(toItemSummary));
  } catch (err) {
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

module.exports = {
  createItem,
  listItems,
  getItem,
  updateItem,
  deleteItem,
  listDue,
  reviewItem,
  skipItem,
};
