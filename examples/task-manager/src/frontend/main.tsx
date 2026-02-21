import React from "react";
import { createRoot } from "react-dom/client";
import { BunBaseProvider } from "./lib/client.ts";
import { App } from "./App.tsx";
import "./styles/globals.css";

createRoot(document.getElementById("root")!).render(
  <BunBaseProvider>
    <App />
  </BunBaseProvider>,
);
