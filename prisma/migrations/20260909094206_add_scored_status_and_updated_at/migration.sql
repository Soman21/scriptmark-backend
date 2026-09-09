/*
  Warnings:

  - Added the required column `updatedAt` to the `Script` table without a default value. This is not possible if the table is not empty.

*/
-- AlterEnum
ALTER TYPE "ScriptStatus" ADD VALUE 'SCORED';

-- AlterTable
ALTER TABLE "Script" ADD COLUMN "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

