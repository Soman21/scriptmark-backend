import { PrismaClient } from '@prisma/client'

// Reuse a single Prisma instance (important in dev with hot-reload)
const prisma = new PrismaClient()

export default prisma
