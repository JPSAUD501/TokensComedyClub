import React from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import LivePage from "./frontend";
import AdminPage from "./admin";
import HistoryPage from "./history";

function AppRouter() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<LivePage />} />
        <Route path="/admin" element={<AdminPage />} />
        <Route path="/history" element={<HistoryPage />} />
        <Route path="/index.html" element={<Navigate to="/" replace />} />
        <Route path="/admin.html" element={<Navigate to="/admin" replace />} />
        <Route path="/history.html" element={<Navigate to="/history" replace />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  );
}

const root = createRoot(document.getElementById("root")!);
root.render(
  <React.StrictMode>
    <AppRouter />
  </React.StrictMode>,
);
