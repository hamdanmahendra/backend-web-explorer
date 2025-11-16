
import { Elysia } from 'elysia'
import { cors } from '@elysiajs/cors'
import { pool } from './db'

const ROOT_ID = 'root' 
const ROOT_UUID = '00000000-0000-0000-0000-000000000001'

function resolveId(id: string) {
  return id === ROOT_ID ? ROOT_UUID : id
}

const app = new Elysia()
  .use(cors())
  .get('/api/v1/health', () => ({ ok: true }))
  .get('/api/v1/folders/:id/children', async ({ params, query }) => {
    const includeTrashed = query.includeTrashed === 'true'
    const id = params.id

    const client = await pool.connect()

    if (id === 'trash') {
      try {
        const trashedRes = await client.query(
          'SELECT * FROM items WHERE is_trashed = true ORDER BY deleted_at DESC NULLS LAST',
        )

        const folder = {
          id: 'trash',
          name: 'Trash',
          type: 'folder',
          parentId: null,
          sizeBytes: null,
          itemsCount: trashedRes.rowCount,
          createdAt: null,
          modifiedAt: null,
          isTrashed: false,
          originalParentId: null,
          deletedAt: null,
        }

        return {
          folder,
          children: trashedRes.rows.map(mapRowToItem),
        }
      } finally {
        client.release()
      }
    }

    const folderId = resolveId(id)

    try {
      const folderRes = await client.query(
        'SELECT * FROM items WHERE id = $1',
        [folderId],
      )
      if (folderRes.rowCount === 0) {
        return new Response('Not found', { status: 404 })
      }

      const folderRow = folderRes.rows[0]

      // const childrenRes = await client.query(
      //   `SELECT i.*,
      //           (
      //             SELECT COUNT(*)
      //             FROM items c
      //             WHERE c.parent_id = i.id AND c.is_trashed = false
      //           ) AS items_count
      //   FROM items i
      //   WHERE i.parent_id = $1
      //     AND i.is_trashed = false
      //   ORDER BY i.name ASC`,
      //   [folderId],
      // )
      const childrenRes = await client.query(
        `SELECT * FROM items
        WHERE parent_id = $1
          ${includeTrashed ? '' : 'AND is_trashed = false'}
        ORDER BY name ASC`,
        [folderId],
      )

      return {
        folder: mapRowToItem(folderRow),
        children: childrenRes.rows.map(mapRowToItem),
      }
    } finally {
      client.release()
    }
  })

  .get('/api/v1/items/:id', async ({ params }) => {
    const client = await pool.connect()
    try {
      const res = await client.query('SELECT * FROM items WHERE id = $1', [
        params.id,
      ])
      if (res.rowCount === 0) {
        return new Response('Not found', { status: 404 })
      }
      return { item: mapRowToItem(res.rows[0]) }
    } finally {
      client.release()
    }
  })
  
  .post('/api/v1/folders', async ({ body }) => {
    const { parentId, name } = (body ?? {}) as {
      parentId: string
      name?: string
    }

    const parentUuid = resolveId(parentId)
    const client = await pool.connect()
    try {
      
      const base = (name ?? 'New Folder').trim() || 'New Folder'
      let finalName = base
      let counter = 1

      for (;;) {
        const exists = await client.query(
          `SELECT 1 FROM items
           WHERE parent_id = $1 AND type = 'folder'
             AND is_trashed = false AND name = $2
           LIMIT 1`,
          [parentUuid, finalName],
        )
        if (exists.rowCount === 0) break
        finalName = `${base} (${counter++})`
      }

      const res = await client.query(
        `INSERT INTO items (id, name, type, parent_id)
         VALUES (gen_random_uuid(), $1, 'folder', $2)
         RETURNING *`,
        [finalName, parentUuid],
      )

      return new Response(JSON.stringify({ folder: mapRowToItem(res.rows[0]) }), {
        status: 201,
        headers: { 'Content-Type': 'application/json' },
      })
    } finally {
      client.release()
    }
  })
 
  .patch('/api/v1/items/:id', async ({ params, body }) => {
    const { name } = body as { name?: string }
    if (!name) {
      return new Response('Bad Request', { status: 400 })
    }

    const client = await pool.connect()
    try {
      
      const curRes = await client.query('SELECT * FROM items WHERE id = $1', [
        params.id,
      ])
      if (curRes.rowCount === 0) {
        return new Response('Not found', { status: 404 })
      }
      const item = curRes.rows[0]

      
      const base = name.trim()
      if (!base || base === item.name) {
        return { item: mapRowToItem(item) }
      }

      let finalName = base
      let counter = 1
      for (;;) {
        const exists = await client.query(
          `SELECT 1 FROM items
           WHERE parent_id = $1 AND type = $2
             AND is_trashed = false AND name = $3
             AND id <> $4
           LIMIT 1`,
          [item.parent_id, item.type, finalName, params.id],
        )
        if (exists.rowCount === 0) break
        finalName = `${base} (${counter++})`
      }

      const updRes = await client.query(
        `UPDATE items
         SET name = $1, modified_at = NOW()
         WHERE id = $2
         RETURNING *`,
        [finalName, params.id],
      )

      return { item: mapRowToItem(updRes.rows[0]) }
    } finally {
      client.release()
    }
  })
  
  .post('/api/v1/items/:id/trash', async ({ params }) => {
    const client = await pool.connect()
    try {
      
      const res = await client.query(
        `UPDATE items
         SET is_trashed = true,
             original_parent_id = COALESCE(original_parent_id, parent_id),
             deleted_at = NOW()
         WHERE id = $1
         RETURNING *`,
        [params.id],
      )
      if (res.rowCount === 0) {
        return new Response('Not found', { status: 404 })
      }
      return { success: true }
    } finally {
      client.release()
    }
  })
  
  .post('/api/v1/items/:id/restore', async ({ params }) => {
    const client = await pool.connect()
    try {
      const res = await client.query(
        `UPDATE items
         SET is_trashed = false,
             parent_id = COALESCE(original_parent_id, $2),
             deleted_at = NULL,
             modified_at = NOW()
         WHERE id = $1
         RETURNING *`,
        [params.id, ROOT_UUID],
      )
      if (res.rowCount === 0) {
        return new Response('Not found', { status: 404 })
      }
      return { item: mapRowToItem(res.rows[0]) }
    } finally {
      client.release()
    }
  })
  
  .delete('/api/v1/items/:id', async ({ params }) => {
    const client = await pool.connect()
    try {
      await client.query('DELETE FROM items WHERE id = $1', [params.id])
      return { success: true }
    } finally {
      client.release()
    }
  })
  
  .get('/api/v1/search', async ({ query }) => {
    const q = String(query.q ?? '').trim()
    if (!q) return { results: [] }

    const folderId = query.folderId ? resolveId(String(query.folderId)) : null
    const scope = String(query.scope ?? 'global') 

    const client = await pool.connect()
    try {
      let sql = `SELECT * FROM items WHERE is_trashed = false AND name ILIKE $1`
      const params: any[] = [`%${q}%`]

      if (scope === 'current' && folderId) {
        sql += ' AND parent_id = $2'
        params.push(folderId)
      }

      const res = await client.query(sql, params)
      return { results: res.rows.map(mapRowToItem) }
    } finally {
      client.release()
    }
  })
  .listen(3000)


function mapRowToItem(row: any) {
  return {
    id: row.id,
    name: row.name,
    type: row.type,
    parentId: row.parent_id,
    sizeBytes: row.size_bytes,
    itemsCount: row.items_count ?? row.items_count === 0 ? 0 : row.items_count,
    createdAt: row.created_at,
    modifiedAt: row.modified_at,
    isTrashed: row.is_trashed,
    originalParentId: row.original_parent_id,
    deletedAt: row.deleted_at,
  }
}
