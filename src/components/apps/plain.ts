import { trouble } from "@/lib/app-health";

export { trouble };

export const parts = (n: number) => (n === 1 ? "1 part" : `${n} parts`);
