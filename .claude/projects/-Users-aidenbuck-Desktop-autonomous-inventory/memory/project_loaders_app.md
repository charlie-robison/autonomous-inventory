---
name: Loaders App Architecture
description: Pallet tracking app with three modes (Receive/Load/Count), VLM-based scanning, voice mode selection, Hawaiian warehouse geo-lookup
type: project
---

Loaders is a pallet/inventory tracking app for a Hawaiian food distributor (HFA).

**Why:** Pallets move through a supply chain (on_boat → at_port → received → loaded) and need real-time tracking. Eventually Meta glasses will be the input device; currently using device camera.

**Three operational modes:**
- **Receive:** VLM scans QR code → pallet set to "received" + warehouse assigned from geolocation (Hawaiian islands: Oahu, Maui, Big Island, Kauai, Molokai, Lanai)
- **Load:** VLM scans QR code + vehicle/truck number → pallet set to "loaded" + vehicle assigned + warehouse cleared
- **Count:** VLM counts product faces on shelves × depth → stores item counts in DB

**How to apply:** Mode is set via voice command or button tap. Camera streams frames to Gemini VLM for analysis. Activity log tracks all changes with approval workflow. Database has: warehouses, vehicles, pallets (with FKs), items, current_app_mode, activity_log.
