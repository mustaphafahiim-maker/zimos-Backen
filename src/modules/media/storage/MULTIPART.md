# Multipart uploads straight to storage

Large files (the digital file library, up to 10 GB — SPEC §18.2) are uploaded
by the browser **directly to private storage in parts**. The API never holds
the bytes. It opens the upload, signs one URL per part, completes the upload,
and later signs a short-lived download link.

`getMultipart()` (index.js) returns the adapter for `STORAGE_PROVIDER`:

| Provider | Adapter | Where the bytes go |
| --- | --- | --- |
| `r2` | `r2Multipart.js` | R2's private bucket (`R2_PRIVATE_BUCKET_NAME`, else the media bucket), via presigned S3 URLs (`s3Presign.js`, SigV4) |
| `local` (sandbox) | `localMultipart.js` | `storage/private/`, via the API's own signed `/api/v1/storage-sandbox` routes (`sandboxRoutes.js`), never mounted in production |

## Contract

```js
create({ key, contentType })                 → { uploadId }
presignPart({ key, uploadId, partNumber, expiresIn }) → { url }   // the browser PUTs the part's bytes here
complete({ key, uploadId, parts: [{ partNumber, etag }] })        // etag = the ETag header the part's PUT answered
abort({ key, uploadId })
head(key)                                    → { sizeBytes } | null
presignGet({ key, filename, contentType, expiresIn }) → url      // downloads as an attachment named `filename`
```

Parts are 64 MB (the last one smaller). S3 wants every part except the last
to be at least 5 MB, and allows at most 10,000 parts. The caller
(`digital/multipartUploads.js`) checks the plan's storage room before
creating the upload, then compares `head()` with the declared size after
`complete()`. Abandoned uploads are aborted after a day.

## R2 setup (integrations team)

The browser PUTs to `https://<account>.r2.cloudflarestorage.com/<bucket>/…`,
so the private bucket needs a **CORS rule**:

```json
[{ "AllowedOrigins": ["https://app.<your-domain>"], "AllowedMethods": ["PUT", "GET"], "AllowedHeaders": ["*"], "ExposeHeaders": ["ETag"], "MaxAgeSeconds": 3600 }]
```

`ExposeHeaders: ETag` is required. Without it the browser cannot read the
part's ETag, and the upload cannot be completed. The API's R2 key needs
object read, write and multipart permissions on that bucket. No other
setting is needed, because the presigned URLs carry the credentials for one
request each.

## Sandbox

With local storage, the part URLs point at
`PUT /api/v1/storage-sandbox/parts/:uploadId/:n?expires&signature`. This
route writes the part and answers its MD5 as the ETag, both in the header
and in a JSON body. Download links point at
`GET /api/v1/storage-sandbox/objects?…&signature`. Signatures are HMACs from
the API's own secret and expire like the real ones.
