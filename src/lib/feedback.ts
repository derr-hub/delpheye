import { create } from "zustand";

/** Whether the feedback window is open; the sidebar button opens it. */
export const useFeedback = create<{ open: boolean }>(() => ({ open: false }));
export const openFeedback = () => useFeedback.setState({ open: true });
export const closeFeedback = () => useFeedback.setState({ open: false });
