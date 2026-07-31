import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const rooms = sqliteTable("rooms", {
  code: text("code").primaryKey(),
  state: text("state").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

export const tierlists = sqliteTable("tierlists", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  items: text("items").notNull(), // JSON array de strings
  ownerId: text("owner_id").notNull(),
  visibility: text("visibility").notNull(), // "public" | "private"
  createdAt: integer("created_at").notNull(),
});
