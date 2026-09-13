// Shared "which photo belongs to this listing" resolver.
//
// Every public listing surface (Home rails, Buy, Rent, the map's popup and
// list cards) used to answer this question its own way, and all of them
// answered it with the same defect: when a listing had no usable photo of
// its own, the page substituted a generic stock building --
//   buy.html/rent.html: `d.img || IMAGES[d.propertyType] || IMAGES.villa`
//   index.html:         `l.img || FEATURED_IMAGES[...] || FEATURED_IMAGES.villa`
//   map.html:           `realListingImage(d)` falling through to `IMAGES[0]`
// so a listing with no photograph showed a photograph anyway, of a building
// that is not the property being advertised. On a real-estate site that is
// not a cosmetic placeholder, it is a fabricated image of the thing for
// sale, and it is indistinguishable to a buyer from a real photo.
//
// This resolver never invents an image. It returns a URL only when the
// listing document itself carries one, and null otherwise, so each caller
// can render an honest "no property image available" placeholder instead of
// a stock photo. Prefer no photo over a wrong photo.
//
// Field order follows how the data actually carries images: the single
// cover-image fields first, then the array fields (`photoUrls` is what
// sell.html's own uploader writes for a seller's real uploaded files;
// `images`/`photos` are older shapes still present on some documents).
//
// NOTE ON PROVENANCE: `img` is a free-text URL field an agent or admin
// types by hand (agent-dashboard.html / admin.html, id="fImg"). Nothing in
// the schema ties its value to a photo of that specific property, so a
// stale, mistyped or pasted-from-the-clipboard URL renders verbatim -- that
// is how an unrelated screenshot once appeared on a property card. No
// display-layer code can detect that a syntactically valid URL depicts the
// wrong building; this resolver removes the images the *code* fabricates,
// not the ones a person typed wrongly. Fixing that one means validating or
// replacing the authoring path (see the note in docs/, and the upload
// button already present next to the field).
//
// Depends on isSafeHttpUrl() from js/escape-html.js -- load that first.
function listingImageUrl(d) {
  if (!d || typeof d !== 'object') return null;
  const candidates = [
    d.img, d.coverImage, d.coverImageUrl, d.imageUrl, d.photoURL,
    Array.isArray(d.photoUrls) ? d.photoUrls[0] : null,
    Array.isArray(d.images) ? d.images[0] : null,
    Array.isArray(d.photos) ? d.photos[0] : null
  ];
  for (const c of candidates) {
    if (typeof c === 'string' && c.trim() && isSafeHttpUrl(c.trim())) {
      return c.trim();
    }
  }
  return null;
}

// The localized "this listing has no photograph" line, for the placeholder
// each page draws in its own markup/icon system.
function listingNoImageLabel() {
  return (window.t && window.t('common.noImageAvailable')) || 'No property image available';
}
