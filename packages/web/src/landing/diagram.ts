// The diagram of examples/supply-chain.yaml exactly as /api/validate returns it (a test keeps the two equal).
import type { SchemaDiagram } from "../api";

export const DIAGRAM_EXAMPLE = "supply-chain.yaml";

export const DIAGRAM: SchemaDiagram = {
  tables: [
    { name: "products", rows: 5, columns: [
      { name: "id", type: "integer", primaryKey: true, unique: false, nullable: false },
      { name: "gtin", type: "string", primaryKey: false, unique: true, nullable: false },
      { name: "dosage_form", type: "string", primaryKey: false, unique: false, nullable: false },
    ] },
    { name: "manufacturers", rows: 4, columns: [
      { name: "id", type: "integer", primaryKey: true, unique: false, nullable: false },
      { name: "gln", type: "string", primaryKey: false, unique: true, nullable: false },
      { name: "name", type: "string", primaryKey: false, unique: false, nullable: false },
      { name: "country", type: "string", primaryKey: false, unique: false, nullable: false },
    ] },
    { name: "wholesalers", rows: 6, columns: [
      { name: "id", type: "integer", primaryKey: true, unique: false, nullable: false },
      { name: "gln", type: "string", primaryKey: false, unique: true, nullable: false },
      { name: "name", type: "string", primaryKey: false, unique: false, nullable: false },
      { name: "state", type: "string", primaryKey: false, unique: false, nullable: false },
    ] },
    { name: "pharmacies", rows: 20, columns: [
      { name: "id", type: "integer", primaryKey: true, unique: false, nullable: false },
      { name: "gln", type: "string", primaryKey: false, unique: true, nullable: false },
      { name: "name", type: "string", primaryKey: false, unique: false, nullable: false },
      { name: "city", type: "string", primaryKey: false, unique: false, nullable: false },
      { name: "kind", type: "string", primaryKey: false, unique: false, nullable: false },
    ] },
    { name: "packs", rows: 80, columns: [
      { name: "id", type: "integer", primaryKey: true, unique: false, nullable: false },
      { name: "serial_no", type: "string", primaryKey: false, unique: true, nullable: false },
      { name: "product_id", type: "integer", primaryKey: false, unique: false, nullable: false, ref: "products.id" },
      { name: "manufacturer_id", type: "integer", primaryKey: false, unique: false, nullable: false, ref: "manufacturers.id" },
      { name: "lot_no", type: "string", primaryKey: false, unique: false, nullable: false },
      { name: "commissioned_on", type: "date", primaryKey: false, unique: false, nullable: false },
      { name: "expiry_on", type: "date", primaryKey: false, unique: false, nullable: false },
    ] },
    { name: "wholesale_receipts", rows: 60, columns: [
      { name: "id", type: "integer", primaryKey: true, unique: false, nullable: false },
      { name: "pack_id", type: "integer", primaryKey: false, unique: true, nullable: false, ref: "packs.id" },
      { name: "wholesaler_id", type: "integer", primaryKey: false, unique: false, nullable: false, ref: "wholesalers.id" },
      { name: "shipped_on", type: "date", primaryKey: false, unique: false, nullable: false },
      { name: "received_on", type: "date", primaryKey: false, unique: false, nullable: false },
    ] },
    { name: "pharmacy_receipts", rows: 45, columns: [
      { name: "id", type: "integer", primaryKey: true, unique: false, nullable: false },
      { name: "wholesale_receipt_id", type: "integer", primaryKey: false, unique: true, nullable: false, ref: "wholesale_receipts.id" },
      { name: "pharmacy_id", type: "integer", primaryKey: false, unique: false, nullable: false, ref: "pharmacies.id" },
      { name: "shipped_on", type: "date", primaryKey: false, unique: false, nullable: false },
      { name: "received_on", type: "date", primaryKey: false, unique: false, nullable: false },
    ] },
    { name: "dispensing", rows: 30, columns: [
      { name: "id", type: "integer", primaryKey: true, unique: false, nullable: false },
      { name: "pharmacy_receipt_id", type: "integer", primaryKey: false, unique: true, nullable: false, ref: "pharmacy_receipts.id" },
      { name: "dispensed_on", type: "date", primaryKey: false, unique: false, nullable: false },
      { name: "channel", type: "string", primaryKey: false, unique: false, nullable: false },
    ] },
    { name: "investigations", rows: 6, columns: [
      { name: "id", type: "integer", primaryKey: true, unique: false, nullable: false },
      { name: "pack_id", type: "integer", primaryKey: false, unique: true, nullable: false, ref: "packs.id" },
      { name: "reason", type: "string", primaryKey: false, unique: false, nullable: false },
      { name: "opened_on", type: "date", primaryKey: false, unique: false, nullable: false },
      { name: "closed_on", type: "date", primaryKey: false, unique: false, nullable: true },
    ] },
  ],
};
