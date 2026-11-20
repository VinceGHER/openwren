import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./lib/i18n";
import "./styles.css";
import { App } from "./app/App";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
