// Creates a small SQLite database with related tables, for trying `mockdata infer`.
//   node examples/make-sample-db.mjs [path]      (default: examples/sample.db)
// Needs Node 22.5+ (uses the built-in node:sqlite).
import { DatabaseSync } from "node:sqlite";
import { existsSync, unlinkSync } from "node:fs";

const path = process.argv[2] ?? new URL("./sample.db", import.meta.url).pathname;
if (existsSync(path)) unlinkSync(path);

const db = new DatabaseSync(path);
db.exec(`
  create table customers (
    id integer primary key,
    email text not null unique,
    name text,
    country text,
    signup_date date not null
  );
  create table orders (
    id integer primary key,
    customer_id integer not null references customers(id),
    status text not null check (status in ('new', 'paid', 'shipped')),
    total real not null,
    placed_at datetime not null
  );
  create table order_items (
    id integer primary key,
    order_id integer not null references orders(id),
    sku text not null,
    quantity integer not null
  );
  create table employees (
    id integer primary key,
    name text not null,
    manager_id integer not null references employees(id)
  );
  -- One row so the tables are not empty. Reflection reads structure only, never rows.
  insert into customers values (1, 'demo@example.com', 'Demo Customer', 'NZ', '2024-01-01');
`);
db.close();
console.log(`created ${path}`);
