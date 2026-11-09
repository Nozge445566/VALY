import { Armchair, Book, Dumbbell, Gamepad2, Home, Package, Shirt, Smartphone, Wrench } from "lucide-react";
import type { LucideIcon } from "lucide-react";

// Only the icons catalog.ts uses are imported, so the rest of lucide-react stays out of the bundle.
const ICONS: Record<string, LucideIcon> = { Armchair, Book, Dumbbell, Gamepad2, Home, Package, Shirt, Smartphone, Wrench };

// Resolve a catalog icon by name, falling back to a box.
export function getIcon(name: string): LucideIcon {
  return ICONS[name] ?? Package;
}
