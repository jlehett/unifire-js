import {
    registerSubcollection,
    createCollectionRefWithPath,
    attachSubmodelInstanceReferencesToDocRef,
    attachSubmodelInstanceReferencesToFetchedData,
} from './utilities/referencing';
import Sanitizer from './utilities/sanitization';
import SubmodelInstance from './submodel-instance';
import Model from './model';
import {
    addDoc,
    getDoc,
    setDoc,
    doc,
    getDocs,
    query,
} from 'firebase/firestore';
import { map } from 'lodash';

/**
 * Class which provides a streamlined approach for creating Firestore
 * submodel objects with various simplified read and write operations.
 * 
 * Before submodels are constructed, the firebase app in use should be
 * tracked via the `setFirebaseApp` function from this package.
 * 
 * Submodels are unique in that each instance associates a particular
 * document as its parent. For this reason, the `Submodel` class is
 * intended as a way to interact with Firestore subcollections in very
 * general aspects.
 * 
 * Each Model (or SubmodelInstance) will contain references to its direct
 * SubmodelInstance children, which can be used for interacting with specific
 * instances of Firestore subcollections.
 * 
 * @example
 * // Given an existing "Profile" model for Firestore, create a new
 * // "Email" submodel for "Profile" model instances.
 * const ProfileEmailModel = new Submodel({
 *      collectionName: 'emails',
 *      collectionProps: [
 *          'address',
 *          'isValid',
 *      ],
 *      propDefaults: {
 *          address: 'john@gmail.com',
 *          isValid: true
 *      }
 * });
 * 
 * @param {SubmodelParams} params The parameters to use when creating the
 * submodel
 */
class Submodel {
    constructor(params) {
        this._validateConstructorParams(params);

        // Create class variables
        this.subcollections = {};

        // Store some info for the SubmodelInstance factory function
        this.collectionName = params.collectionName;
        this.sanitizer = new Sanitizer(
            params.collectionProps,
            params.propDefaults || {}
        );

        // Register the subcollection on the parent
        params.parent.registerSubcollection(this);

        // Add partials
        this.registerSubcollection = childModel => registerSubcollection(
            this.subcollections,
            childModel
        );
    }

    /********************
     * PUBLIC FUNCTIONS *
     ********************/

    /**
     * Sanitizes the specified data and writes it to a new document in the
     * given collection reference path with an auto-assigned ID.
     * @public
     * @function
     * 
     * @param {string} path The path to the subcollection to write the new
     * document to
     * @param {Object} data The data to sanitize and write to the new document
     * @param {WriteToNewDocParams} [params] Various settings for the operation
     * @returns {Promise<Object>} Resolves with the newly created document
     * reference, populated with additional subcollection info
     */
    async writeToNewDoc(path, data, params) {
        this._verifyPathIncludesSubmodelCollectionName(path);

        // Sanitize the data
        const sanitizedData = this.sanitizer.getSanitizedDataToSave(
            data,
            params?.mergeWithDefaultValues
        );

        // Write the doc, and get the doc ref
        const collectionRef = createCollectionRefWithPath(path);
        const docRef = await addDoc(collectionRef, sanitizedData);
        
        // Attach additional info to doc ref and return
        attachSubmodelInstanceReferencesToDocRef(docRef, this.subcollections);
        return docRef;
    }

    /**
     * Sanitizes the specified data and writes it to a specified document
     * in a specified instance of the subcollection. A new document will
     * be created if it doesn't already exist.
     * 
     * By default, this will completely overwrite the existing document, if
     * one exists. Properties unspecified by the new data will be deleted
     * from the existing document.
     * 
     * In order to merge the existing data with the new data, the
     * `mergeWithExistingValues` property can be set to true in the `params`
     * object.
     * @public
     * @function
     * 
     * @param {string} path The path to the document to write to
     * @param {Object} data The data to sanitize and write to the new document
     * @param {WriteToIDParams} [params] Various settings for the operation
     * @returns {Promise<Object>} Resolves with the newly created document
     * reference, populated with additional subcollection info
     */
    async writeToPath(path, data, params) {
        this._verifyPathIncludesSubmodelCollectionName(path);

        // Sanitize the data
        const sanitizedData = this.sanitizer.getSanitizedDataToSave(
            data,
            params?.mergeWithDefaultValues
        );

        // Retrieve the doc ref
        const { id, collectionPath } = this._getCollectionPathAndIDFromPath(path);
        const collectionRef = createCollectionRefWithPath(collectionPath);
        const docRef = doc(collectionRef, id);

        // Write the data
        params?.transaction
            ? await params.transaction.set(
                docRef,
                sanitizedData,
                { merge: params?.mergeWithExistingValues }
            )
            : await setDoc(
                docRef,
                sanitizedData,
                { merge: params?.mergeWithExistingValues }
            );
        
        // Attach additional info to doc ref and return
        attachSubmodelInstanceReferencesToDocRef(docRef, this.subcollections);
        return docRef;
    }

    /**
     * Retrieves the specified document's data from the database, if it exists.
     * @public
     * @function
     * 
     * @param {string} path Path specifying both the collection path and the
     * ID of the document to retrieve
     * @param {GetByPathParams} [params] Various settings for the operation
     * @returns {Promise<Object | null} If the document exists, the promise
     * will resolve with the sanitized data for the document; otherwise, the
     * promise will resolve with `null`
     */
    async getByPath(path, params) {
        this._verifyPathIncludesSubmodelCollectionName(path);

        // Retrieve the doc ref
        const { id, collectionPath } = this._getCollectionPathAndIDFromPath(path);
        const collectionRef = createCollectionRefWithPath(collectionPath);
        const docRef = doc(collectionRef, id);

        // Retrieve the data
        const docSnap = params?.transaction
            ? await params.transaction.get(docRef)
            : await getDoc(docRef);

        // Sanitize the data
        let sanitizedData = this.sanitizer.sanitizeFromRead(docSnap);
        if (sanitizedData) {
            // For each subcollection registered to the model instance, create
            // and attach submodel instances for reference
            attachSubmodelInstanceReferencesToFetchedData(sanitizedData, this.subcollections);
        }
        
        // Return the sanitized data
        return sanitizedData;
    }

    /**
     * Retrieves all documents from the database matching the specified query
     * parameters, in the given Firestore path.
     * @public
     * @function
     * 
     * @param {string} path Path specifying the specific subcollection instance
     * path
     * @param {function[]} queryFns Array of Firestore query functions to use
     * in the query, e.g., `limit`, `orderBy`, and `where`
     * @returns {Promise<Object[]>} Resolves with an array of all documents in
     * the specific subcollection matching the specified query
     */
    async getByQueryInInstance(path, queryFns) {
        this._verifyPathIncludesSubmodelCollectionName(path);

        // Retrieve the collection ref
        const collectionRef = createCollectionRefWithPath(path);

        // Construct the query function
        const q = query(collectionRef, ...queryFns);

        // Make the query call
        const querySnapshot = await getDocs(q);
        
        // Sanitize the documents
        const sanitizedDocuments = this.sanitizer.sanitizeFromRead(querySnapshot);

        // For each document, and for each subcolleciton specified for the model,
        // create and attach submodel instances for reference
        map(
            sanitizedDocuments,
            doc => attachSubmodelInstanceReferencesToFetchedData(doc, this.subcollections)
        );

        // Return the final results
        return sanitizedDocuments;
    }

    /***********************
     * PROTECTED FUNCTIONS *
     ***********************/

    /**
     * Validates the Submodel constructor's params object.
     * @private
     * @function
     * 
     * @param {Object} params Argument given to the Submodel's constructor
     */
    _validateConstructorParams(params) {
        if (!params.collectionName) {
            throw new Error('`collectionName` must be specified when constructing a new submodel.');
        }
        if (!params.collectionProps) {
            throw new Error('`collectionProps` must be specified when constructing a new submodel.');
        }
        if (
            !params.parent ||
            (
                !params.parent instanceof Model &&
                !params.parent instanceof Submodel
            )
        ) {
            throw new Error('`parent` must be specified and be of type `Model` or `Submodel` when constructing a new submodel.');
        }
    }
    
    /**
     * Given the doc or doc reference to associate as the parent, create a
     * new submodel instance.
     * @private
     * @function
     * 
     * @param {Firestore.DocumentSnapshot | Firestore.DocumentReference} docOrDocRef
     * The doc or doc reference to set as the parent of the new submodel
     * instance
     * @returns {SubmodelInstance} The created submodel instance
     */
    _createSubmodelInstance(docOrDocRef) {
        let docRef = docOrDocRef._ref || docOrDocRef;
        return new SubmodelInstance({
            collectionName: this.collectionName,
            parentDocRef: docRef,
            sanitizer: this.sanitizer,
            subcollections: this.subcollections,
        });
    }

    /**
     * Verify that the path given includes this submodel's collection name
     * to attempt to ensure developers pass the correct absolute Firestore
     * path.
     * @private
     * @function
     * 
     * @param {string} path The path to verify
     */
    _verifyPathIncludesSubmodelCollectionName(path) {
        if (
            !path ||
            !path.includes ||
            !path.includes(this.collectionName)
        ) {
            throw new Error(
                `The path given must include the submodel's collection name.\n` +
                `Path given: ${path}\n` +
                `Subcollection name is: ${this.collectionName}`
            );
        }
    }

    /**
     * Given a path containing both the collection path and an ID, return
     * an object with the collection path split from the ID.
     * @private
     * @function
     * 
     * @param {string} path The path including both the collection path and
     * the ID
     * @returns {Object} Returns an object with `id` and `collectionPath`
     * properties 
     */
    _getCollectionPathAndIDFromPath(path) {
        const pathSegments = path.split('/');
        const id = pathSegments.pop();
        const collectionPath = pathSegments.join('/');
        return {
            id,
            collectionPath
        };
    }
}

export default Submodel;