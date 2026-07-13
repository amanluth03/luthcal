// Extended-property keys used to tag events LuthCal writes to the shared
// calendar. They live under `extendedProperties.private`, so they never show
// up in the normal Google Calendar UI but do round-trip through the API
// (list/get/watch notifications) — which is how we tell "events LuthCal
// created" apart from events a family member added directly in a calendar
// app (those have neither property).
export const MEMBER_IDS_PROPERTY = "luthcalMemberIds";
export const CREATED_VIA_PROPERTY = "luthcalCreatedVia";
