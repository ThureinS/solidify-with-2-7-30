const express = require('express');
const validate = require('../middleware/validate');
const blockDemoWrites = require('../middleware/blockDemoWrites');
const controller = require('../controllers/items.controller');
const {
  createItemSchema,
  updateItemSchema,
  listItemsQuerySchema,
  resetItemSchema,
  switchModeSchema,
  curveQuerySchema,
} = require('../dto/item.schemas');
const {
  reviewActionSchema,
  skipActionSchema,
  dueQuerySchema,
  reviewHistoryQuerySchema,
} = require('../dto/review.schemas');

// Takes the "who is this request" middleware as a parameter so the same
// route table serves both the real authenticated mount (requireAuth) and
// the public read-only demo mount (demoAuth) -- one list of routes that
// can't drift out of sync between the two, and blockDemoWrites applies to
// both regardless of which one resolved req.user (ADR 0004).
function buildItemsRouter(identifyUser) {
  const router = express.Router();

  router.use(identifyUser, blockDemoWrites);

  router.post('/', validate(createItemSchema), controller.createItem);
  router.get('/', validate(listItemsQuerySchema, 'query'), controller.listItems);

  // Must come before '/:id' -- otherwise Express would match "due"/"review-history" as an :id.
  router.get('/due', validate(dueQuerySchema, 'query'), controller.listDue);
  router.get('/review-history', validate(reviewHistoryQuerySchema, 'query'), controller.reviewHistory);

  router.get('/:id', controller.getItem);
  router.patch('/:id', validate(updateItemSchema), controller.updateItem);
  router.delete('/:id', controller.deleteItem);
  router.post('/:id/review', validate(reviewActionSchema), controller.reviewItem);
  router.post('/:id/skip', validate(skipActionSchema), controller.skipItem);
  router.get('/:id/curve', validate(curveQuerySchema, 'query'), controller.getItemCurve);
  router.post('/:id/reset', validate(resetItemSchema), controller.resetItem);
  router.post('/:id/mode', validate(switchModeSchema), controller.switchMode);

  return router;
}

module.exports = buildItemsRouter;
