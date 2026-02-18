import React from "react";
import { createRoot } from "react-dom/client";
import { TSBaseProvider } from "./lib/client.ts";
import { App } from "./App.tsx";
import "./styles/globals.css";

createRoot(document.getElementById("root")!).render(
  <TSBaseProvider>
    <App />
  </TSBaseProvider>,
);
