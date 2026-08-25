-- CreateEnum
CREATE TYPE "ItemMode" AS ENUM ('FIXED', 'ADAPTIVE');

-- CreateEnum
CREATE TYPE "Grade" AS ENUM ('AGAIN', 'HARD', 'GOOD', 'EASY');

-- AlterTable
ALTER TABLE "items" ADD COLUMN     "difficulty" DOUBLE PRECISION,
ADD COLUMN     "finalIntervalDays" INTEGER NOT NULL DEFAULT 30,
ADD COLUMN     "lastReviewDate" DATE,
ADD COLUMN     "mode" "ItemMode" NOT NULL DEFAULT 'FIXED',
ADD COLUMN     "stability" DOUBLE PRECISION;

-- AlterTable
ALTER TABLE "reviews" ADD COLUMN     "grade" "Grade";
