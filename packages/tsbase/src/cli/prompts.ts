import * as clack from "@clack/prompts";

export { clack };

export function cancelIfAborted(value: unknown) {
  if (clack.isCancel(value)) {
    clack.cancel("Operation cancelled.");
    process.exit(0);
  }
}

export async function text(
  message: string,
  defaultValue?: string,
): Promise<string> {
  const result = await clack.text({
    message,
    defaultValue,
    placeholder: defaultValue,
  });
  cancelIfAborted(result);
  return (result as string) || defaultValue || "";
}

export async function select<T extends string>(
  message: string,
  options: { label: string; value: T }[],
): Promise<T> {
  const result = await clack.select({
    message,
    options,
  });
  cancelIfAborted(result);
  return result as T;
}

export async function multiSelect<T extends string>(
  message: string,
  options: { label: string; value: T }[],
): Promise<T[]> {
  const result = await clack.multiselect({
    message,
    options,
    required: false,
  });
  cancelIfAborted(result);
  return result as T[];
}

export async function confirm(
  message: string,
  defaultYes = true,
): Promise<boolean> {
  const result = await clack.confirm({ message, initialValue: defaultYes });
  cancelIfAborted(result);
  return result as boolean;
}

export function closePrompts() {
  // No-op — clack manages its own terminal state
}
