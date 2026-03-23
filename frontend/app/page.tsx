"use client";

import { useEffect, useState } from "react";

interface Item {
  id: number;
  name: string;
  description: string;
  quantity: number;
}

export default function Home() {
  const [items, setItems] = useState<Item[]>([]);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [quantity, setQuantity] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const fetchItems = async () => {
    try {
      const res = await fetch("http://localhost:8000/api/items");
      if (!res.ok) throw new Error("Failed to fetch items");
      const data = await res.json();
      setItems(data);
    } catch (err) {
      setError("Failed to load items.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchItems();
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const res = await fetch("http://localhost:8000/api/items", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          description,
          quantity: Number(quantity),
        }),
      });
      if (!res.ok) throw new Error("Failed to add item");
      setName("");
      setDescription("");
      setQuantity("");
      await fetchItems();
    } catch (err) {
      setError("Failed to add item.");
    }
  };

  return (
    <div className="min-h-screen bg-gray-50 p-8">
      <div className="max-w-2xl mx-auto">
        <h1 className="text-3xl font-bold mb-8">Autonomous Inventory</h1>

        <section className="mb-10">
          <h2 className="text-xl font-semibold mb-4">Add Item</h2>
          <form onSubmit={handleSubmit} className="flex flex-col gap-3">
            <input
              type="text"
              placeholder="Name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
              className="border border-gray-300 rounded px-3 py-2"
            />
            <input
              type="text"
              placeholder="Description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              required
              className="border border-gray-300 rounded px-3 py-2"
            />
            <input
              type="number"
              placeholder="Quantity"
              value={quantity}
              onChange={(e) => setQuantity(e.target.value)}
              required
              className="border border-gray-300 rounded px-3 py-2"
            />
            <button
              type="submit"
              className="bg-blue-600 text-white rounded px-4 py-2 hover:bg-blue-700 w-fit"
            >
              Add Item
            </button>
          </form>
        </section>

        <section>
          <h2 className="text-xl font-semibold mb-4">Items</h2>
          {error && <p className="text-red-500 mb-2">{error}</p>}
          {loading ? (
            <p className="text-gray-500">Loading...</p>
          ) : items.length === 0 ? (
            <p className="text-gray-500">No items found.</p>
          ) : (
            <ul className="flex flex-col gap-3">
              {items.map((item) => (
                <li
                  key={item.id}
                  className="border border-gray-200 rounded p-4 bg-white"
                >
                  <p className="font-medium">{item.name}</p>
                  <p className="text-gray-600 text-sm">{item.description}</p>
                  <p className="text-gray-500 text-sm">
                    Quantity: {item.quantity}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}
