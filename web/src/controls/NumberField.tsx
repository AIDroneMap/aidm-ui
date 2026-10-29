import type { ComponentProps } from "react";
import { TextField } from "./TextField.tsx";
export function NumberField(props: Omit<ComponentProps<typeof TextField>, "type">) {
  return <TextField {...props} type="number" />;
}
