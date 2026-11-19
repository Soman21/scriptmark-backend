-- AlterTable
ALTER TABLE "ScriptAnswer" ADD COLUMN     "remark" TEXT;

-- AlterTable
ALTER TABLE "ScriptPage" ADD COLUMN     "ocrLines" JSONB;

-- CreateTable
CREATE TABLE "ScriptInk" (
    "id" TEXT NOT NULL,
    "scriptId" TEXT NOT NULL,
    "pageNumber" INTEGER NOT NULL,
    "items" JSONB NOT NULL,
    "updatedById" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ScriptInk_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ScriptInk_scriptId_pageNumber_key" ON "ScriptInk"("scriptId", "pageNumber");

-- AddForeignKey
ALTER TABLE "ScriptInk" ADD CONSTRAINT "ScriptInk_scriptId_fkey" FOREIGN KEY ("scriptId") REFERENCES "Script"("id") ON DELETE CASCADE ON UPDATE CASCADE;

