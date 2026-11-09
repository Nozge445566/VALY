// Legacy display catalog (icons and labels for History). It is NOT used by the valuation engine, which lives in
// supabase/functions/value-item. The base values below are historical resale midpoints and are never used to price anything.

import { TEXTS } from "./texts.ts";

export type Condition = "new" | "like-new" | "good" | "fair" | "poor";

export interface Category {
  id: string;
  label: string;
  icon: string; // lucide icon name
  // representative item types within the category, each with a base market value
  types: { id: string; label: string; baseValue: number }[];
  // brands commonly seen on resale platforms with a premium multiplier vs generic
  brands: { name: string; multiplier: number }[];
  // Annual depreciation rate — how fast items in this category lose value per year.
  // Electronics and fashion depreciate fast; furniture and tools hold value longer.
  annualDepreciation: number;
  // Price volatility — how much resale prices vary for items in this category.
  // Higher = wider estimate range (collectibles, luxury vary a lot).
  volatility: number;
}

export const CATEGORIES: Category[] = [
  {
    id: "electronics",
    label: "Electronics",
    icon: "Smartphone",
    types: [
      { id: "smartphone", label: "Smartphone", baseValue: 280 },
      { id: "laptop", label: "Laptop", baseValue: 520 },
      { id: "tablet", label: "Tablet", baseValue: 210 },
      { id: "camera", label: "Camera", baseValue: 320 },
      { id: "headphones", label: "Headphones / Audio", baseValue: 95 },
      { id: "gaming-console", label: "Gaming Console", baseValue: 260 },
      { id: "tv", label: "TV", baseValue: 280 },
      { id: "monitor", label: "Monitor", baseValue: 160 },
      { id: "smartwatch", label: "Smartwatch", baseValue: 140 },
    ],
    brands: [
      { name: "Apple", multiplier: 1.6 },
      { name: "Samsung", multiplier: 1.3 },
      { name: "Sony", multiplier: 1.35 },
      { name: "Google", multiplier: 1.25 },
      { name: "Microsoft", multiplier: 1.2 },
      { name: "Bose", multiplier: 1.4 },
      { name: "LG", multiplier: 1.15 },
      { name: "Dell", multiplier: 1.1 },
      { name: "Lenovo", multiplier: 1.05 },
      { name: "Canon", multiplier: 1.2 },
      { name: "Nikon", multiplier: 1.2 },
      { name: "JBL", multiplier: 1.1 },
      { name: "Asus", multiplier: 1.1 },
      { name: "Garmin", multiplier: 1.25 },
      { name: "Unknown", multiplier: 0.8 },
    ],
    annualDepreciation: 0.28,
    volatility: 0.22,
  },
  {
    id: "fashion",
    label: "Clothing & Fashion",
    icon: "Shirt",
    types: [
      { id: "sneakers", label: "Sneakers", baseValue: 80 },
      { id: "jacket", label: "Jacket / Coat", baseValue: 70 },
      { id: "bag", label: "Bag / Handbag", baseValue: 90 },
      { id: "watch", label: "Watch", baseValue: 120 },
      { id: "dress", label: "Dress", baseValue: 45 },
      { id: "jeans", label: "Jeans", baseValue: 35 },
      { id: "shoes", label: "Shoes (non-sneaker)", baseValue: 40 },
      { id: "accessory", label: "Accessory / Jewelry", baseValue: 35 },
    ],
    brands: [
      { name: "Rolex", multiplier: 5.0 },
      { name: "Omega", multiplier: 3.0 },
      { name: "Louis Vuitton", multiplier: 4.5 },
      { name: "Hermès", multiplier: 6.0 },
      { name: "Chanel", multiplier: 5.0 },
      { name: "Gucci", multiplier: 3.5 },
      { name: "Prada", multiplier: 3.0 },
      { name: "Nike", multiplier: 1.4 },
      { name: "Jordan", multiplier: 1.7 },
      { name: "Adidas", multiplier: 1.2 },
      { name: "New Balance", multiplier: 1.2 },
      { name: "Levi's", multiplier: 1.15 },
      { name: "Carhartt", multiplier: 1.3 },
      { name: "Patagonia", multiplier: 1.4 },
      { name: "The North Face", multiplier: 1.35 },
      { name: "Ralph Lauren", multiplier: 1.3 },
      { name: "Unknown", multiplier: 0.7 },
    ],
    annualDepreciation: 0.18,
    volatility: 0.30,
  },
  {
    id: "furniture",
    label: "Furniture",
    icon: "Armchair",
    types: [
      { id: "sofa", label: "Sofa / Couch", baseValue: 180 },
      { id: "chair", label: "Chair", baseValue: 70 },
      { id: "table", label: "Table / Desk", baseValue: 110 },
      { id: "bed", label: "Bed / Mattress", baseValue: 130 },
      { id: "shelf", label: "Shelf / Cabinet", baseValue: 80 },
      { id: "lamp", label: "Lamp", baseValue: 35 },
    ],
    brands: [
      { name: "IKEA", multiplier: 0.8 },
      { name: "Herman Miller", multiplier: 2.5 },
      { name: "Steelcase", multiplier: 1.8 },
      { name: "West Elm", multiplier: 1.4 },
      { name: "Crate & Barrel", multiplier: 1.3 },
      { name: "Unknown", multiplier: 0.85 },
    ],
    annualDepreciation: 0.08,
    volatility: 0.18,
  },
  {
    id: "home",
    label: "Home & Garden",
    icon: "Home",
    types: [
      { id: "kitchenware", label: "Kitchenware", baseValue: 25 },
      { id: "appliance", label: "Small Appliance", baseValue: 45 },
      { id: "garden-tool", label: "Garden Tool", baseValue: 35 },
      { id: "decor", label: "Decor", baseValue: 20 },
      { id: "lighting", label: "Lighting", baseValue: 30 },
    ],
    brands: [
      { name: "Dyson", multiplier: 1.8 },
      { name: "KitchenAid", multiplier: 1.5 },
      { name: "Vitamix", multiplier: 1.6 },
      { name: "Stihl", multiplier: 1.4 },
      { name: "Unknown", multiplier: 0.8 },
    ],
    annualDepreciation: 0.10,
    volatility: 0.16,
  },
  {
    id: "sports",
    label: "Sports & Outdoors",
    icon: "Dumbbell",
    types: [
      { id: "bicycle", label: "Bicycle", baseValue: 200 },
      { id: "skis", label: "Skis / Snowboard", baseValue: 130 },
      { id: "gym", label: "Gym Equipment", baseValue: 80 },
      { id: "tent", label: "Tent / Camping", baseValue: 60 },
      { id: "ball-sport", label: "Ball / Racquet Sport", baseValue: 45 },
    ],
    brands: [
      { name: "Trek", multiplier: 1.7 },
      { name: "Specialized", multiplier: 1.6 },
      { name: "Giant", multiplier: 1.3 },
      { name: "Salomon", multiplier: 1.4 },
      { name: "Patagonia", multiplier: 1.4 },
      { name: "Unknown", multiplier: 0.8 },
    ],
    annualDepreciation: 0.12,
    volatility: 0.24,
  },
  {
    id: "tools",
    label: "Tools & DIY",
    icon: "Wrench",
    types: [
      { id: "power-tool", label: "Power Tool", baseValue: 80 },
      { id: "hand-tool", label: "Hand Tool", baseValue: 30 },
      { id: "workshop", label: "Workshop Equipment", baseValue: 90 },
    ],
    brands: [
      { name: "Bosch", multiplier: 1.3 },
      { name: "DeWalt", multiplier: 1.4 },
      { name: "Makita", multiplier: 1.4 },
      { name: "Milwaukee", multiplier: 1.45 },
      { name: "Stanley", multiplier: 1.1 },
      { name: "Unknown", multiplier: 0.8 },
    ],
    annualDepreciation: 0.06,
    volatility: 0.14,
  },
  {
    id: "books",
    label: "Books & Media",
    icon: "Book",
    types: [
      { id: "book", label: "Book", baseValue: 8 },
      { id: "textbook", label: "Textbook", baseValue: 35 },
      { id: "vinyl", label: "Vinyl / CD", baseValue: 12 },
      { id: "video-game", label: "Video Game", baseValue: 15 },
      { id: "board-game", label: "Board Game", baseValue: 18 },
    ],
    brands: [
      { name: "Unknown", multiplier: 0.9 },
    ],
    annualDepreciation: 0.05,
    volatility: 0.26,
  },
  {
    id: "toys",
    label: "Toys & Games",
    icon: "Gamepad2",
    types: [
      { id: "lego", label: "Lego / Building", baseValue: 30 },
      { id: "action-figure", label: "Action Figure", baseValue: 25 },
      { id: "doll", label: "Doll", baseValue: 20 },
      { id: "rc", label: "RC / Hobby", baseValue: 50 },
    ],
    brands: [
      { name: "LEGO", multiplier: 1.6 },
      { name: "Mattel", multiplier: 1.1 },
      { name: "Hasbro", multiplier: 1.1 },
      { name: "Unknown", multiplier: 0.8 },
    ],
    annualDepreciation: 0.07,
    volatility: 0.22,
  },
  {
    id: "other",
    label: "Other",
    icon: "Package",
    types: [{ id: "misc", label: "Miscellaneous", baseValue: 30 }],
    brands: [{ name: "Unknown", multiplier: 0.9 }],
    annualDepreciation: 0.10,
    volatility: 0.20,
  },
];

export const CONDITIONS: { id: Condition; label: string; multiplier: number; desc: string }[] = [
  { id: "new", label: "New / Sealed", multiplier: 1.0, desc: "Unused, original packaging" },
  { id: "like-new", label: "Like New", multiplier: 0.85, desc: "Barely used, no visible wear" },
  { id: "good", label: "Good", multiplier: 0.65, desc: "Used, minor wear, fully functional" },
  { id: "fair", label: "Fair", multiplier: 0.45, desc: "Visible wear, works fine" },
  { id: "poor", label: "Poor", multiplier: 0.25, desc: "Heavy wear or needs repair" },
];

export function findCategory(id: string): Category | undefined {
  return CATEGORIES.find((c) => c.id === id);
}
