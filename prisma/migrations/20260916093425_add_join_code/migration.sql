/*
  Warnings:

  - A unique constraint covering the columns `[joinCode]` on the table `MarkingSession` will be added. If there are existing duplicate values, this will fail.

*/
-- AlterTable
ALTER TABLE "MarkingSession" ADD COLUMN     "joinCode" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "MarkingSession_joinCode_key" ON "MarkingSession"("joinCode");
