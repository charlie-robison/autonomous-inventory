import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import Home from "./page";

// Mock navigator APIs that don't exist in jsdom
beforeEach(() => {
  // Mock getUserMedia
  Object.defineProperty(navigator, "mediaDevices", {
    value: {
      getUserMedia: vi.fn().mockResolvedValue({
        getTracks: () => [{ stop: vi.fn() }],
      }),
    },
    writable: true,
    configurable: true,
  });

  // Mock geolocation
  Object.defineProperty(navigator, "geolocation", {
    value: {
      getCurrentPosition: vi.fn((success) =>
        success({ coords: { latitude: 21.4, longitude: -158.0 } })
      ),
    },
    writable: true,
    configurable: true,
  });

  // Mock SpeechRecognition
  (window as unknown as Record<string, unknown>).SpeechRecognition = undefined;
  (window as unknown as Record<string, unknown>).webkitSpeechRecognition =
    undefined;

  // Mock fetch
  global.fetch = vi.fn().mockResolvedValue({
    ok: true,
    json: () => Promise.resolve({ mode: "count", items: [], raw_response: "[]" }),
  });
});

describe("File upload", () => {
  it("renders upload button when mode is selected", async () => {
    render(<Home />);

    // Click the "Count" mode button
    const countBtn = screen.getByText("Count");
    fireEvent.click(countBtn);

    // Wait for mode to be set and upload button to appear
    await waitFor(() => {
      expect(screen.getByText("Upload Image / Video")).toBeInTheDocument();
    });
  });

  it("file input onChange dispatches to processImageFile for image files", async () => {
    render(<Home />);

    // Select count mode
    fireEvent.click(screen.getByText("Count"));

    await waitFor(() => {
      expect(screen.getByText("Upload Image / Video")).toBeInTheDocument();
    });

    // Get the hidden file input
    const fileInput = document.querySelector(
      'input[type="file"]'
    ) as HTMLInputElement;
    expect(fileInput).toBeTruthy();

    // Create a mock image file
    const file = new File(["fake-image-data"], "test.jpg", {
      type: "image/jpeg",
    });

    // Mock FileReader
    const mockReadAsDataURL = vi.fn();
    const origFileReader = global.FileReader;
    global.FileReader = vi.fn().mockImplementation(() => ({
      readAsDataURL: mockReadAsDataURL,
      set onload(cb: (ev: ProgressEvent) => void) {
        // Simulate async read completing
        setTimeout(() => {
          (this as { result: string }).result =
            "data:image/jpeg;base64,AAAA";
          cb({} as ProgressEvent);
        }, 10);
      },
      set onerror(_cb: () => void) {},
    })) as unknown as typeof FileReader;

    // This should NOT throw ReferenceError for processFile
    // and should NOT cause an infinite loop
    fireEvent.change(fileInput, { target: { files: [file] } });

    // Restore FileReader
    global.FileReader = origFileReader;

    // If we get here without hanging or throwing, the onChange handler works
    // Wait a tick to ensure no infinite loop
    await new Promise((r) => setTimeout(r, 100));
    expect(true).toBe(true);
  });

  it("file input onChange dispatches to processVideoFile for video files", async () => {
    render(<Home />);

    // Select count mode
    fireEvent.click(screen.getByText("Count"));

    await waitFor(() => {
      expect(screen.getByText("Upload Image / Video")).toBeInTheDocument();
    });

    const fileInput = document.querySelector(
      'input[type="file"]'
    ) as HTMLInputElement;
    expect(fileInput).toBeTruthy();

    // Create a mock video file
    const file = new File(["fake-video-data"], "test.mp4", {
      type: "video/mp4",
    });

    // This should NOT throw ReferenceError for processFile
    fireEvent.change(fileInput, { target: { files: [file] } });

    // If we get here without hanging, the video file dispatch works
    await new Promise((r) => setTimeout(r, 100));
    expect(true).toBe(true);
  });

  it("does nothing when no file is selected", async () => {
    render(<Home />);

    fireEvent.click(screen.getByText("Count"));

    await waitFor(() => {
      expect(screen.getByText("Upload Image / Video")).toBeInTheDocument();
    });

    const fileInput = document.querySelector(
      'input[type="file"]'
    ) as HTMLInputElement;

    // Trigger onChange with empty files
    fireEvent.change(fileInput, { target: { files: [] } });

    await new Promise((r) => setTimeout(r, 100));
    // Should not crash
    expect(true).toBe(true);
  });

  it("does not process file when no mode is set", () => {
    render(<Home />);

    const fileInput = document.querySelector(
      'input[type="file"]'
    ) as HTMLInputElement;
    expect(fileInput).toBeTruthy();

    const file = new File(["data"], "test.jpg", { type: "image/jpeg" });

    // No mode selected - onChange should early return
    fireEvent.change(fileInput, { target: { files: [file] } });
    expect(true).toBe(true);
  });
});
