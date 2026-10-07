# Query plans: proof that the indexes work

Run on 2026-10-07 against the **local Docker Postgres 16** (`db` service). Never against prod.

This file proves that the two indexes in `prisma/schema.prisma` are used by the queries they exist for:

| Index | Built for | Route |
|---|---|---|
| `items_userId_nextReviewDate_idx` on `items ("userId", "nextReviewDate")` | due items for one user | `GET /items/due` |
| `reviews_itemId_date_idx` on `reviews ("itemId", date)` | reviews of one item, oldest first | `GET /items/:id` (item detail) |

The `reviews` index also helps a third route, `GET /items/review-history` (the calendar page). See [B3](#b3-review-calendar-get-itemsreview-history).

## Words used in this file

- **EXPLAIN (ANALYZE, BUFFERS)**: Postgres runs the query for real and prints the plan it used, with real times, real row counts and memory/disk page counts.
- **Plan / planner**: the planner is the part of Postgres that picks *how* to run a query. The plan is its choice.
- **Seq Scan** (sequential scan): read every row of the table and throw away the ones that don't match.
- **Index Scan**: walk the index (a sorted lookup structure, like a book's index) straight to the matching rows.
- **Bitmap Index Scan + Bitmap Heap Scan**: first collect the matching row locations from the index, then read those table pages in disk order. Postgres picks this when it expects more than a handful of rows.
- **Buffers: shared hit=N**: N pages of 8 kB were found in Postgres's memory cache. **read=N** means N pages came from disk. Fewer pages = less work.
- **Rows Removed by Filter**: rows Postgres looked at and then rejected. A big number means wasted work.

## How the SQL was captured (not guessed)

`src/lib/prisma.js` reuses `global.__prisma` if it exists. A throwaway script put a Prisma client with query logging (`log: [{ emit: 'event', level: 'query' }]`) there, then called the **real** service functions (`listDueItems`, `getItemById`, `getReviewHistory`) from `src/services/items.service.js`. These are the exact statements Prisma printed:

**Due items** (`listDueItems`):

```sql
SELECT "public"."items"."id", "public"."items"."userId", "public"."items"."text", "public"."items"."dateAdded", "public"."items"."nextReviewDate", "public"."items"."mode"::text, "public"."items"."stage", "public"."items"."isComplete", "public"."items"."finalIntervalDays", "public"."items"."difficulty", "public"."items"."stability", "public"."items"."lastReviewDate", "public"."items"."deletedAt" FROM "public"."items" WHERE ("public"."items"."userId" = $1 AND "public"."items"."deletedAt" IS NULL AND "public"."items"."isComplete" = $2 AND "public"."items"."nextReviewDate" <= $3) ORDER BY "public"."items"."nextReviewDate" ASC OFFSET $4
-- params: ["<userId>", false, "2026-10-07T00:00:00.000Z", "0"]
```

**Item detail, review list** (`getItemById`, the second of its two queries; `include: { reviews: { orderBy: { date: 'asc' } } }`):

```sql
SELECT "public"."reviews"."id", "public"."reviews"."itemId", "public"."reviews"."date", "public"."reviews"."result"::text, "public"."reviews"."grade"::text FROM "public"."reviews" WHERE "public"."reviews"."itemId" IN ($1) ORDER BY "public"."reviews"."date" ASC OFFSET $2
-- params: ["<itemId>", "0"]
```

**Review calendar** (`getReviewHistory`):

```sql
SELECT COUNT(*) AS "_count$_all", "public"."reviews"."date", "public"."reviews"."result"::text FROM "public"."reviews" LEFT JOIN "public"."items" AS "j0" ON ("j0"."id") = ("public"."reviews"."itemId") WHERE (("j0"."userId" = $1 AND "j0"."deletedAt" IS NULL AND ("j0"."id" IS NOT NULL)) AND "public"."reviews"."date" >= $2 AND "public"."reviews"."date" <= $3) GROUP BY "public"."reviews"."date", "public"."reviews"."result" OFFSET $4
-- params: ["<userId>", "2026-01-01T00:00:00.000Z", "2026-12-31T00:00:00.000Z", "0"]
```

In `psql`, each statement was wrapped in `PREPARE name(...) AS <statement>` and run with `EXPLAIN (ANALYZE, BUFFERS) EXECUTE name(...)`. That keeps the `$1, $2…` parameters, as Prisma sends them. Pasting values into the SQL by hand can change their types, and then the plan is a different one.

Every plan below except one is the **second run** (a "warm" run). The first run loads pages into memory; the second shows the steady state, so its buffers are all `hit`. The exception is the A2 reviews plan, a first run: its `read=1` is one page that came from disk.

## A. Seed data only (27 users, 29 items, 183 reviews)

### A1. Due items, demo user: Seq Scan (correct)

```
 Sort  (cost=1.61..1.63 rows=9 width=211) (actual time=0.009..0.010 rows=11 loops=1)
   Sort Key: "nextReviewDate"
   Sort Method: quicksort  Memory: 27kB
   Buffers: shared hit=1
   ->  Seq Scan on items  (cost=0.00..1.46 rows=9 width=211) (actual time=0.003..0.006 rows=11 loops=1)
         Filter: (("deletedAt" IS NULL) AND (NOT "isComplete") AND ("nextReviewDate" <= '2026-10-07'::date) AND ("userId" = '9c914d83-2668-4ee8-ad7b-dd6d053fafb4'::text))
         Rows Removed by Filter: 18
         Buffers: shared hit=1
 Planning Time: 0.036 ms
 Execution Time: 0.016 ms
```

**Reading:** the whole `items` table fits in **one 8 kB page** (`shared hit=1`). Reading one page is cheaper than opening an index and then the table, so the planner skips the index. This is the right choice, not a missing index.

### A2. Same query with `SET enable_seqscan = off`

```
 Index Scan using "items_userId_nextReviewDate_idx" on items  (cost=0.14..8.40 rows=9 width=211) (actual time=0.026..0.030 rows=11 loops=1)
   Index Cond: (("userId" = '9c914d83-2668-4ee8-ad7b-dd6d053fafb4'::text) AND ("nextReviewDate" <= '2026-10-07'::date))
   Filter: (("deletedAt" IS NULL) AND (NOT "isComplete"))
   Rows Removed by Filter: 1
   Buffers: shared hit=3 dirtied=1
 Planning Time: 0.044 ms
 Execution Time: 0.050 ms
```

```
 Index Scan using "reviews_itemId_date_idx" on reviews  (cost=0.27..8.30 rows=1 width=142) (actual time=0.078..0.078 rows=0 loops=1)
   Index Cond: ("itemId" = 'a6e17715-ded4-4413-a457-fc356fff518c'::text)
   Buffers: shared hit=1 read=1
 Planning Time: 0.032 ms
 Execution Time: 0.081 ms
```

**Reading:** when Seq Scan is forbidden, both indexes are usable, and the `Index Cond` lines show which columns the index answers. The plans are **slower** here (0.050 ms vs 0.016 ms, 3 pages vs 1), which is why the planner didn't pick them on its own. `enable_seqscan = off` proves that the index *can* be used. It does not prove that the index is *better*. Part B shows that.

## B. Bulk data: 100,000 items, 300,000 reviews

Inside one transaction, the test added **1,000 throwaway users** (`explain-throwaway-N@example.invalid`) with **100 items each** and **3 reviews per item**. Due dates were spread over one year around 2026-10-07; ~10% of items were archived and ~5% soft-deleted. Then it ran `ANALYZE` so the planner had fresh row counts.

The query target is **one** of those users. The table is big, but one user's slice of it is small. That is the case an index is built for.

The transaction ended with `ROLLBACK`, so no other session ever saw the rows. After that: `VACUUM ANALYZE users, items, reviews`, and a check found **0** leftover `explain-throwaway-%` users. The table counts were back to 27 / 29 / 183.

### B1. Due items, one user among 100,000 items: index used

```
 Sort  (cost=179.54..179.64 rows=42 width=164) (actual time=0.035..0.038 rows=46 loops=1)
   Sort Key: "nextReviewDate"
   Sort Method: quicksort  Memory: 31kB
   Buffers: shared hit=7
   ->  Bitmap Heap Scan on items  (cost=4.92..178.40 rows=42 width=164) (actual time=0.012..0.023 rows=46 loops=1)
         Recheck Cond: (("userId" = '4d978f86-680b-485f-aa89-675f6755cfb0'::text) AND ("nextReviewDate" <= '2026-10-07'::date))
         Filter: (("deletedAt" IS NULL) AND (NOT "isComplete"))
         Rows Removed by Filter: 7
         Heap Blocks: exact=3
         Buffers: shared hit=7
         ->  Bitmap Index Scan on "items_userId_nextReviewDate_idx"  (cost=0.00..4.91 rows=49 width=0) (actual time=0.009..0.009 rows=53 loops=1)
               Index Cond: (("userId" = '4d978f86-680b-485f-aa89-675f6755cfb0'::text) AND ("nextReviewDate" <= '2026-10-07'::date))
               Buffers: shared hit=4
 Planning Time: 0.054 ms
 Execution Time: 0.049 ms
```

### B4. The same query with index scans turned off, for comparison

(`SET LOCAL enable_indexscan = off; SET LOCAL enable_bitmapscan = off;`)

```
 Sort  (cost=3425.78..3425.88 rows=42 width=164) (actual time=9.377..9.381 rows=46 loops=1)
   Sort Key: "nextReviewDate"
   Sort Method: quicksort  Memory: 31kB
   Buffers: shared hit=1924
   ->  Seq Scan on items  (cost=0.00..3424.64 rows=42 width=164) (actual time=4.513..9.362 rows=46 loops=1)
         Filter: (("deletedAt" IS NULL) AND (NOT "isComplete") AND ("nextReviewDate" <= '2026-10-07'::date) AND ("userId" = '4d978f86-680b-485f-aa89-675f6755cfb0'::text))
         Rows Removed by Filter: 99983
         Buffers: shared hit=1924
 Planning Time: 0.082 ms
 Execution Time: 9.398 ms
```

**Reading B1 against B4:**

| | With index (B1) | Without index (B4) |
|---|---|---|
| Access path | Bitmap Index Scan on `items_userId_nextReviewDate_idx` | Seq Scan on `items` |
| Execution time | **0.049 ms** | 9.398 ms (~190× slower) |
| Pages touched | **7** (4 index + 3 table) | 1,924 (the whole table) |
| Rows looked at, then thrown away | **7** | 99,983 |
| Rows returned | 46 | 46 |

- The index answers **both** conditions it contains: `userId = …` and `nextReviewDate <= today` (the `Index Cond` line). That leaves 53 candidate rows out of 100,000.
- `deletedAt IS NULL` and `isComplete = false` are **not** in the index, so Postgres checks them afterwards (`Filter`). They removed only 7 rows, so leaving them out of the index costs almost nothing.
- There is still a small `Sort` on `nextReviewDate`. The planner expected about 49 rows on a few pages, so it chose a bitmap scan. A bitmap scan reads pages in disk order, not index order, so the result must be sorted again. A plain Index Scan would return rows already in date order and need no Sort, but sorting 46 rows in memory takes microseconds, so the planner judged the bitmap scan cheaper overall.
- Honest caveat: the test inserted each user's items together, so one user's 100 rows sit in only 3 table pages (`Heap Blocks: exact=3`). In real use, items are added over months, so one user's rows spread over more pages. Real page counts would be somewhat higher. The Seq Scan cost would not change, because it always reads the whole table.

### B2. Item detail review list, one item among 300,000 reviews: index used

```
 Sort  (cost=16.30..16.31 rows=3 width=142) (actual time=0.008..0.009 rows=3 loops=1)
   Sort Key: date
   Sort Method: quicksort  Memory: 25kB
   Buffers: shared hit=6
   ->  Bitmap Heap Scan on reviews  (cost=4.45..16.28 rows=3 width=142) (actual time=0.006..0.007 rows=3 loops=1)
         Recheck Cond: ("itemId" = '03d8d291-c62b-4fed-b394-8daf3b02ee1d'::text)
         Heap Blocks: exact=3
         Buffers: shared hit=6
         ->  Bitmap Index Scan on "reviews_itemId_date_idx"  (cost=0.00..4.45 rows=3 width=0) (actual time=0.004..0.004 rows=3 loops=1)
               Index Cond: ("itemId" = '03d8d291-c62b-4fed-b394-8daf3b02ee1d'::text)
               Buffers: shared hit=3
 Planning Time: 0.024 ms
 Execution Time: 0.013 ms
```

**Reading:** **0.013 ms**, **6 pages**, 3 rows found, **0 rows wasted**, out of 300,000 reviews. The index jumps straight to this item's reviews. Without it, Postgres would read all 300,000 rows to find 3.

### B3. Review calendar (`GET /items/review-history`)

This query isn't forced in any way. It is the planner's free choice:

```
 GroupAggregate  (cost=1861.34..1868.34 rows=280 width=48) (actual time=0.363..0.421 rows=174 loops=1)
   Group Key: reviews.date, reviews.result
   Buffers: shared hit=584
   ->  Sort  (cost=1861.34..1862.04 rows=280 width=8) (actual time=0.361..0.373 rows=288 loops=1)
         Sort Key: reviews.date, reviews.result
         Sort Method: quicksort  Memory: 34kB
         Buffers: shared hit=584
         ->  Nested Loop  (cost=9.61..1849.95 rows=280 width=8) (actual time=0.013..0.328 rows=288 loops=1)
               Buffers: shared hit=584
               ->  Bitmap Heap Scan on items j0  (cost=9.18..333.08 rows=94 width=37) (actual time=0.009..0.020 rows=96 loops=1)
                     Recheck Cond: ("userId" = '4d978f86-680b-485f-aa89-675f6755cfb0'::text)
                     Filter: (("deletedAt" IS NULL) AND (id IS NOT NULL))
                     Rows Removed by Filter: 4
                     Heap Blocks: exact=3
                     Buffers: shared hit=8
                     ->  Bitmap Index Scan on "items_userId_nextReviewDate_idx"  (cost=0.00..9.16 rows=99 width=0) (actual time=0.007..0.007 rows=100 loops=1)
                           Index Cond: ("userId" = '4d978f86-680b-485f-aa89-675f6755cfb0'::text)
                           Buffers: shared hit=5
               ->  Index Scan using "reviews_itemId_date_idx" on reviews  (cost=0.42..16.11 rows=3 width=45) (actual time=0.002..0.003 rows=3 loops=96)
                     Index Cond: (("itemId" = j0.id) AND (date >= '2026-01-01'::date) AND (date <= '2026-12-31'::date))
                     Buffers: shared hit=576
 Planning:
   Buffers: shared hit=22
 Planning Time: 0.141 ms
 Execution Time: 0.436 ms
```

**Reading:** this one query uses **both** indexes, one after the other:

1. `items_userId_nextReviewDate_idx` finds this user's 100 items. Only the **first** column (`userId`) is used here. A composite index (an index on more than one column) still works when you search on its leading column alone.
2. For each of the 96 live items (`loops=96`), `reviews_itemId_date_idx` finds that item's reviews **in 2026**. Both index columns are used: `itemId = …` and the `date` range.
3. The 288 matching reviews are sorted and counted per (date, result).

Total: **0.436 ms**, **584 pages**, all from memory. 576 of those pages are the 96 small index lookups (about 6 pages each). This is a **Nested Loop** join: for each row on the outer side, look up matches on the inner side. It is a good plan when the outer side is small, like one user's items.

## How to reproduce

1. `docker compose up -d db`
2. Capture the SQL: set `global.__prisma` to a `PrismaClient` with `log: [{ emit: 'event', level: 'query' }]`, then `require('src/services/items.service.js')` and call the service functions.
3. In `psql`: `PREPARE` the three statements above. Then, inside `BEGIN; … ROLLBACK;`, insert the bulk rows with `generate_series`, run `ANALYZE`, and run each `EXPLAIN (ANALYZE, BUFFERS) EXECUTE …` twice.
4. After the rollback: run `VACUUM ANALYZE users, items, reviews;`. Then check `SELECT count(*) FROM users WHERE email LIKE 'explain-throwaway-%';` returns 0.
